import { spawn } from 'node:child_process'
import path from 'node:path'

// Starts a second Platform server for a spec that needs Platform under another configuration, such as another
// PLATFORM_LICENSE. It runs `next start` on the production build of this checkout, which `npm run build` makes, as the
// CI job does before it starts the run's server, with the environment of the run and the spec's variables over it, and
// it shares the run's database and Keycloak.

const ROOT = path.resolve(__dirname, '../../..')
const NEXT_BIN = path.join(ROOT, 'node_modules/next/dist/bin/next')
const START_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 10_000

export interface PlatformServer {
  /** The URL the server answers on, which is also its AUTH_URL. */
  readonly baseURL: string
  /** What the server has written to stdout and stderr so far. */
  output(): string
  /** Stops the server and waits until it has exited; a second call does nothing. */
  stop(): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Starts the server on `port` with AUTH_URL http://localhost:<port> and `env` over the run's environment, and resolves
 * once its login page answers. Throws with the server's output when it exits or does not answer within 60 s.
 */
export async function startPlatformServer(port: number, env: Record<string, string>): Promise<PlatformServer> {
  const baseURL = `http://localhost:${port}`
  const child = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...env, AUTH_URL: baseURL },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  let exitCode: number | null | undefined
  const exited = new Promise<void>(resolve => {
    child.once('exit', code => {
      exitCode = code
      resolve()
    })
  })

  const server: PlatformServer = {
    baseURL,
    output: () => output,
    async stop() {
      if (exitCode !== undefined) return
      child.kill('SIGTERM')
      const stopped = await Promise.race([exited.then(() => true), delay(STOP_TIMEOUT_MS).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        await exited
      }
    },
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    if (exitCode !== undefined) {
      throw new Error(`The Platform server on port ${port} exited with code ${exitCode} before it answered:\n${output}`)
    }
    try {
      const response = await fetch(`${baseURL}/login`, { redirect: 'manual' })
      if (response.ok) return server
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await server.stop()
      throw new Error(`The Platform server on port ${port} did not answer within ${START_TIMEOUT_MS / 1000} s:\n${output}`)
    }
    await delay(500)
  }
}
