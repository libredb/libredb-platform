import { logger } from '@/shared/lib/logger'
import { readRuntimeConfig } from '@/shared/lib/runtime-config'
import { getLockPool } from '@/shared/lib/jobs/lock-pool'
import { TASKS } from '@/shared/lib/jobs/registry'
import { startScheduler, type Scheduler } from '@/shared/lib/jobs/scheduler'
import { startSealCanaryPublication } from '@/shared/lib/bridge/seal-canary'
import { db } from '@/shared/lib/db'
import { logLicenseStatus } from '@/shared/lib/license/install-license'
import { loadSealKey } from '@/shared/lib/sealing/seal-key'

/**
 * The Node.js half of register(): validates the runtime configuration and runs the self-test seal of
 * BRIDGE_SEAL_PUBLIC_KEY, so a misconfigured container fails at start, and then, in self-hosted mode, starts the
 * in-process scheduler and the publication of the seal canary.
 * Between the two it logs the license status, which never stops the start.
 */
export function registerNodeRuntime(): void {
  let config
  let sealKey
  try {
    config = readRuntimeConfig(process.env)
    // A key that nothing can be sealed to stops the start in either mode; only cloud mode may run without a key.
    sealKey = config.BRIDGE_SEAL_PUBLIC_KEY === undefined ? undefined : loadSealKey(config.BRIDGE_SEAL_PUBLIC_KEY)
  } catch (error) {
    logger.error('Platform failed to start', error instanceof Error ? error : new Error(String(error)))
    // `next start` and the standalone server.js only log an error thrown by register() ("Failed to prepare server")
    // and keep listening, answering every request with 500, so the process ends once register() has rejected.
    setImmediate(() => process.exit(1))
    throw error
  }
  // Outside the checks above, which require a token in self-hosted mode, because no token stops the start: an install
  // whose token fails verification adds no seat and keeps its existing access, and logLicenseStatus never throws.
  logLicenseStatus()
  let scheduler: Scheduler | undefined
  if (config.DEPLOYMENT_MODE === 'self-hosted') {
    scheduler = startScheduler({ pool: getLockPool(), tasks: TASKS })
    // readRuntimeConfig requires BRIDGE_SEAL_PUBLIC_KEY in self-hosted mode, so the key is loaded.
    startSealCanaryPublication(db, sealKey!)
  }
  if (process.env.NEXT_MANUAL_SIG_HANDLE === 'true') handleShutdownSignals(scheduler)
}

// The exit codes Next.js gives these signals.
const SIGNAL_EXIT_CODES = { SIGTERM: 143, SIGINT: 130 } as const

/**
 * The image's serve command sets NEXT_MANUAL_SIG_HANDLE=true, because Next.js's own handler closes the HTTP server and
 * calls process.exit(143) without waiting (node_modules/next/dist/server/lib/start-server.js), which would cut a
 * scheduled task short. This handler waits for scheduler.stop(), which lets the runs in progress end and releases their
 * advisory locks, and then ends the process, which closes the server.
 */
function handleShutdownSignals(scheduler: Scheduler | undefined): void {
  let stopping = false
  const shutdown = (signal: keyof typeof SIGNAL_EXIT_CODES) => {
    if (stopping) return
    stopping = true
    logger.info(`Received ${signal}, stopping`)
    void Promise.resolve(scheduler?.stop()).then(
      () => process.exit(SIGNAL_EXIT_CODES[signal]),
      error => {
        logger.error('Stopping the scheduler failed', error instanceof Error ? error : new Error(String(error)))
        process.exit(1)
      },
    )
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
