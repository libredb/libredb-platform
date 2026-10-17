import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import { register } from './instrumentation'
import { ConfigError } from '@/shared/lib/errors'
import { startScheduler } from '@/shared/lib/jobs/scheduler'
import { getLockPool } from '@/shared/lib/jobs/lock-pool'
import { TASKS } from '@/shared/lib/jobs/registry'
import type { LicenseErrorCode, LicenseKey, LicensePayload, LicenseState } from '@/shared/lib/license'
import { LICENSE_TEST_KEY, signLicense } from '../tests/license/test-keys'

vi.mock('@/shared/lib/jobs/scheduler', () => ({ startScheduler: vi.fn() }))
vi.mock('@/shared/lib/jobs/lock-pool', () => ({ getLockPool: vi.fn(() => ({ connect: vi.fn() })) }))
// The Prisma client's raw statement, through which the canary publication inserts into platform.seal_canary.
const executeRaw = vi.hoisted(() => vi.fn<(query: TemplateStringsArray, ...values: unknown[]) => Promise<number>>())
vi.mock('@/shared/lib/db', () => ({ db: { $executeRaw: executeRaw } }))
// The key list a start reads, which the license tests fill: with the list of the build, or with a test key. The mock
// stays for the whole file, because Vitest settles a pending vi.doUnmock and a later vi.doMock of one module in either
// order, and a start could then read the other list.
const licenseKeys = vi.hoisted((): LicenseKey[] => [])
vi.mock('@/shared/lib/license/keys', () => ({ LICENSE_KEYS: licenseKeys }))

const VARIABLES = [
  'NEXT_RUNTIME',
  'NODE_ENV',
  'DEPLOYMENT_MODE',
  'DATABASE_URL',
  'AUTH_SECRET',
  'AUTH_URL',
  'STUDIO_PUBLIC_URL',
  'AUTH_KEYCLOAK_ISSUER',
  'AUTH_KEYCLOAK_ID',
  'AUTH_KEYCLOAK_SECRET',
  'KEYCLOAK_ADMIN_URL',
  'BRIDGE_SEAL_PUBLIC_KEY',
  'PLATFORM_LICENSE',
  'NEXT_MANUAL_SIG_HANDLE',
]

// Studio's seal public key: the recipient key of Studio's lsb1 test vectors, a published test key, and its kid.
const SEAL_PUBLIC_KEY = 'b6-f045B6re3Ue7V8Cr5jO9ApZzyOxGk659gM3tn5wE'
const SEAL_KEY_KID = 'caea4ffac78f6e7c'
// 32 zero bytes, the X25519 point of order 2: the form of a key, and a key that nothing can be sealed to.
const LOW_ORDER_SEAL_PUBLIC_KEY = 'A'.repeat(43)

// An environment with an invalid DEPLOYMENT_MODE and two invalid secrets that must never be printed.
const INVALID_ENV: Record<string, string | undefined> = {
  NODE_ENV: 'production',
  DEPLOYMENT_MODE: 'bogus-mode',
  DATABASE_URL: 'mysql://root:leaked-db-password@db.internal/libredb',
  AUTH_SECRET: 'leaked-short-secret',
}

const VALID_ENV: Record<string, string | undefined> = {
  NODE_ENV: 'production',
  DEPLOYMENT_MODE: 'self-hosted',
  DATABASE_URL: 'postgresql://libredb_platform:db-password@db.internal:5432/libredb?schema=platform',
  AUTH_SECRET: 'auth-secret-value-of-at-least-32-characters',
  AUTH_URL: 'https://platform.example.test',
  STUDIO_PUBLIC_URL: 'https://studio.example.test',
  AUTH_KEYCLOAK_ISSUER: 'https://auth.example.test/realms/libredb',
  AUTH_KEYCLOAK_ID: 'libredb-platform',
  AUTH_KEYCLOAK_SECRET: 'keycloak-client-secret-value',
  BRIDGE_SEAL_PUBLIC_KEY: SEAL_PUBLIC_KEY,
}

function stubEnv(runtime: string, env: Record<string, string | undefined>) {
  for (const name of VARIABLES) vi.stubEnv(name, env[name])
  vi.stubEnv('NEXT_RUNTIME', runtime)
}

// The exit is scheduled after register() rejects, so wait for one turn of the event loop.
function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

describe('register', () => {
  let exit: MockInstance<typeof process.exit>
  let consoleError: MockInstance<typeof console.error>

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // The database answers by default, so the canary of the configured key is inserted at the first attempt.
    executeRaw.mockResolvedValue(1)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.mocked(startScheduler).mockClear()
    vi.mocked(getLockPool).mockClear()
    executeRaw.mockReset()
  })

  it('register throws ConfigError for an invalid environment on the nodejs runtime', async () => {
    stubEnv('nodejs', INVALID_ENV)

    const error = await register().then(() => null, (reason: unknown) => reason)
    await nextTurn()

    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).message).toMatch(/DEPLOYMENT_MODE/)
    expect((error as ConfigError).message).not.toContain('leaked')
  })

  it('stops the process with exit code 1 after logging the error by variable name only', async () => {
    stubEnv('nodejs', INVALID_ENV)

    await expect(register()).rejects.toThrow(ConfigError)
    await nextTurn()

    expect(exit).toHaveBeenCalledWith(1)
    const output = consoleError.mock.calls.flat().join('\n')
    for (const name of ['DEPLOYMENT_MODE', 'DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL']) {
      expect(output).toContain(name)
    }
    expect(output).not.toContain('leaked')
  })

  it('accepts a valid environment on the nodejs runtime', async () => {
    stubEnv('nodejs', VALID_ENV)

    await expect(register()).resolves.toBeUndefined()
    await nextTurn()

    expect(exit).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('starts the scheduler in self-hosted mode only', async () => {
    stubEnv('nodejs', VALID_ENV)
    await register()
    expect(startScheduler).toHaveBeenCalledTimes(1)
    expect(startScheduler).toHaveBeenCalledWith({ pool: vi.mocked(getLockPool).mock.results[0].value, tasks: TASKS })

    vi.mocked(startScheduler).mockClear()
    stubEnv('nodejs', { ...VALID_ENV, DEPLOYMENT_MODE: 'cloud' })
    await register()
    expect(startScheduler).not.toHaveBeenCalled()

    // An invalid configuration stops the start before the scheduler.
    stubEnv('nodejs', { ...INVALID_ENV, DEPLOYMENT_MODE: 'self-hosted' })
    await expect(register()).rejects.toThrow(ConfigError)
    await nextTurn()
    expect(startScheduler).not.toHaveBeenCalled()

    stubEnv('edge', VALID_ENV)
    await register()
    expect(startScheduler).not.toHaveBeenCalled()
  })

  it('register fails with ConfigError naming BRIDGE_SEAL_PUBLIC_KEY when it is not a key', async () => {
    // 31 bytes in unpadded base64url.
    stubEnv('nodejs', { ...VALID_ENV, BRIDGE_SEAL_PUBLIC_KEY: 'leaked' + 'A'.repeat(36) })

    const error = await register().then(() => null, (reason: unknown) => reason)
    await nextTurn()

    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).message)
      .toContain('BRIDGE_SEAL_PUBLIC_KEY must be the unpadded base64url of a raw 32-byte X25519 public key')
    expect(exit).toHaveBeenCalledWith(1)
    expect(consoleError.mock.calls.flat().join('\n')).not.toContain('leaked')
    expect(startScheduler).not.toHaveBeenCalled()
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it('register fails with ConfigError naming BRIDGE_SEAL_PUBLIC_KEY when the self-test fails', async () => {
    // Cloud mode tests a key it is given as well, because it seals credentials to it.
    for (const mode of ['self-hosted', 'cloud']) {
      stubEnv('nodejs', { ...VALID_ENV, DEPLOYMENT_MODE: mode, BRIDGE_SEAL_PUBLIC_KEY: LOW_ORDER_SEAL_PUBLIC_KEY })
      exit.mockClear()
      consoleError.mockClear()

      const error = await register().then(() => null, (reason: unknown) => reason)
      await nextTurn()

      expect(error, mode).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).message, mode).toMatch(/^BRIDGE_SEAL_PUBLIC_KEY fails the self-test seal: .*\(LOW_ORDER_POINT\)$/)
      expect(exit, mode).toHaveBeenCalledWith(1)
      const output = consoleError.mock.calls.flat().join('\n')
      expect(output, mode).toContain('BRIDGE_SEAL_PUBLIC_KEY')
      expect(output, mode).toContain('LOW_ORDER_POINT')
    }
    // Nothing starts with a key that nothing can be sealed to.
    expect(startScheduler).not.toHaveBeenCalled()
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it('publishes the canary of BRIDGE_SEAL_PUBLIC_KEY in self-hosted mode only', async () => {
    stubEnv('nodejs', VALID_ENV)
    await register()

    expect(executeRaw).toHaveBeenCalledTimes(1)
    const [, kid, envelope] = executeRaw.mock.calls[0]
    expect(kid).toBe(SEAL_KEY_KID)
    expect(envelope).toMatch(new RegExp(`^lsb1\\.${SEAL_KEY_KID}\\.[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{22,}$`))

    executeRaw.mockClear()
    stubEnv('nodejs', { ...VALID_ENV, DEPLOYMENT_MODE: 'cloud' })
    await register()
    stubEnv('edge', VALID_ENV)
    await register()
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it('a database outage at boot leaves the canary publication retrying every 30 s without failing register', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // Prisma's error while the server does not answer, without any part of DATABASE_URL but its host.
      executeRaw.mockRejectedValue(new Error("Can't reach database server at `db.internal:5432`"))
      stubEnv('nodejs', VALID_ENV)

      await expect(register()).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(0)
      expect(executeRaw).toHaveBeenCalledTimes(1)
      expect(startScheduler).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(29_999)
      expect(executeRaw).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(executeRaw).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(executeRaw).toHaveBeenCalledTimes(3)

      // The database is back: the next attempt publishes the canary, and no attempt follows.
      executeRaw.mockResolvedValue(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(executeRaw).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(executeRaw).toHaveBeenCalledTimes(4)

      // Every attempt inserts the canary of the configured key's kid.
      for (const [, kid, envelope] of executeRaw.mock.calls) {
        expect(kid).toBe(SEAL_KEY_KID)
        expect(envelope).toMatch(new RegExp(`^lsb1\\.${SEAL_KEY_KID}\\.`))
      }
      expect(exit).not.toHaveBeenCalled()
      // Each failed attempt is logged with the database error.
      const failures = consoleError.mock.calls.map((call) => call.join(' ')).filter((line) => line.includes('seal canary'))
      expect(failures).toHaveLength(3)
      expect(failures.every((line) => line.includes("Can't reach database server"))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('shutdown under NEXT_MANUAL_SIG_HANDLE', () => {
    const SIGNALS = ['SIGTERM', 'SIGINT'] as const
    let existing: Record<string, NodeJS.SignalsListener[]>

    beforeEach(() => {
      existing = Object.fromEntries(SIGNALS.map(signal => [signal, process.listeners(signal)]))
    })

    afterEach(() => {
      // Removes the handlers register() added, and keeps the test runner's own.
      for (const signal of SIGNALS) {
        for (const listener of process.listeners(signal)) {
          if (!existing[signal].includes(listener)) process.removeListener(signal, listener)
        }
      }
    })

    function added(signal: (typeof SIGNALS)[number]) {
      return process.listeners(signal).filter(listener => !existing[signal].includes(listener))
    }

    it('SIGTERM waits for scheduler.stop() before the process exits in self-hosted mode', async () => {
      let finishStop!: () => void
      const stop = vi.fn(() => new Promise<void>(resolve => { finishStop = resolve }))
      vi.mocked(startScheduler).mockReturnValueOnce({ stop })
      stubEnv('nodejs', { ...VALID_ENV, NEXT_MANUAL_SIG_HANDLE: 'true' })
      await register()

      process.emit('SIGTERM', 'SIGTERM')
      expect(stop).toHaveBeenCalledTimes(1)
      await nextTurn()
      expect(exit).not.toHaveBeenCalled()

      finishStop()
      await nextTurn()
      expect(exit).toHaveBeenCalledWith(143)
      // A second signal while stopping starts no second stop.
      process.emit('SIGINT', 'SIGINT')
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it('SIGINT exits 130, a failed stop exits 1, and cloud mode exits without a scheduler', async () => {
      vi.mocked(startScheduler).mockReturnValueOnce({ stop: vi.fn(async () => {}) })
      stubEnv('nodejs', { ...VALID_ENV, NEXT_MANUAL_SIG_HANDLE: 'true' })
      await register()
      process.emit('SIGINT', 'SIGINT')
      await nextTurn()
      expect(exit).toHaveBeenCalledWith(130)

      for (const signal of SIGNALS) for (const listener of added(signal)) process.removeListener(signal, listener)
      exit.mockClear()
      vi.mocked(startScheduler).mockReturnValueOnce({ stop: vi.fn(async () => { throw new Error('lock release failed') }) })
      await register()
      process.emit('SIGTERM', 'SIGTERM')
      await nextTurn()
      expect(exit).toHaveBeenCalledWith(1)
      expect(consoleError.mock.calls.flat().join('\n')).toContain('lock release failed')

      for (const signal of SIGNALS) for (const listener of added(signal)) process.removeListener(signal, listener)
      exit.mockClear()
      stubEnv('nodejs', { ...VALID_ENV, DEPLOYMENT_MODE: 'cloud', NEXT_MANUAL_SIG_HANDLE: 'true' })
      await register()
      process.emit('SIGTERM', 'SIGTERM')
      await nextTurn()
      expect(exit).toHaveBeenCalledWith(143)
    })

    it('register adds no signal handler without NEXT_MANUAL_SIG_HANDLE, so Next.js keeps its own', async () => {
      stubEnv('nodejs', VALID_ENV)
      await register()
      expect(added('SIGTERM')).toEqual([])
      expect(added('SIGINT')).toEqual([])
    })
  })

  it('register does nothing on the edge runtime', async () => {
    stubEnv('edge', INVALID_ENV)

    await expect(register()).resolves.toBeUndefined()
    await nextTurn()

    expect(exit).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  describe('the license at start', () => {
    // A license issued 2026-10-16 that expires 2027-10-16, with 2 admin and 25 user seats, bound to no host.
    const LICENSE: LicensePayload = {
      v: 1,
      id: 'LIC-2026.0042',
      customer: 'Example Customer',
      adminSeats: 2,
      userSeats: 25,
      issuedAt: 1_792_108_800,
      expiresAt: 1_823_644_800,
    }

    beforeEach(async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const build = await vi.importActual<typeof import('@/shared/lib/license/keys')>('@/shared/lib/license/keys')
      licenseKeys.splice(0, licenseKeys.length, ...build.LICENSE_KEYS)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /**
     * Runs register() as a new server process does, because Platform reads its configuration and verifies its license
     * once per process, and expects the start to succeed. The logger writes JSON lines.
     */
    async function startProcess(env: Record<string, string | undefined>): Promise<void> {
      for (const method of [console.log, console.warn, console.error]) vi.mocked(method).mockClear()
      vi.mocked(startScheduler).mockClear()
      executeRaw.mockClear()
      stubEnv('nodejs', env)
      vi.stubEnv('LOG_LEVEL', 'info')
      vi.stubEnv('LOG_FORMAT', 'json')
      vi.resetModules()

      const fresh = await import('./instrumentation')
      await expect(fresh.register()).resolves.toBeUndefined()
      await nextTurn()

      expect(exit).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
    }

    function printed(): string[] {
      return [console.log, console.warn, console.error].flatMap(method => vi.mocked(method).mock.calls.map(call => call.join(' ')))
    }

    // The printed lines about the license, parsed.
    function licenseLines(): Array<Record<string, unknown>> {
      return printed().filter(line => /licen[cs]e/i.test(line)).map(line => JSON.parse(line))
    }

    // No printed line holds the token, nor its payload or signature.
    function expectTokenNotPrinted(token: string) {
      const text = printed().join('\n')
      for (const part of [token, ...token.split('.').filter(segment => segment.length > 16)]) {
        expect(text).not.toContain(part)
      }
    }

    // The rest of the start goes on: the scheduler of the process started last runs, and the seal canary is published.
    async function expectStarted(name: string) {
      const { startScheduler: started } = await import('@/shared/lib/jobs/scheduler')
      expect(started, name).toHaveBeenCalledTimes(1)
      expect(executeRaw, name).toHaveBeenCalledTimes(1)
    }

    it('starts with a PLATFORM_LICENSE that fails verification and logs one line with the state and code, never the token', async () => {
      const cases: Array<[string, LicenseErrorCode]> = [
        ['ldl1.leaked-license-value', 'LICENSE_MALFORMED'],
        // keys.test.ts keeps every test key out of the key list of the build, so the build knows no kid of a test key.
        [signLicense(LICENSE_TEST_KEY, LICENSE), 'LICENSE_UNKNOWN_KID'],
      ]
      for (const [token, code] of cases) {
        await startProcess({ ...VALID_ENV, PLATFORM_LICENSE: token })

        expect(licenseLines(), code).toEqual([expect.objectContaining({ level: 'warn', state: 'invalid', code })])
        expectTokenNotPrinted(token)
        await expectStarted(code)
      }
    })

    it('starts in every state of a valid license and logs one line with that state', async () => {
      licenseKeys.splice(0, licenseKeys.length, { kid: LICENSE_TEST_KEY.kid, publicKey: LICENSE_TEST_KEY.publicKey })
      vi.useFakeTimers({ toFake: ['Date'] })
      const token = signLicense(LICENSE_TEST_KEY, LICENSE)
      // An instant in each state: the license is expiring from 2027-09-16, in grace from 2027-10-16 and expired from
      // 2027-10-30, when no seat can be added any more.
      const cases: Array<[string, LicenseState]> = [
        ['2027-01-01T00:00:00Z', 'active'],
        ['2027-10-01T00:00:00Z', 'expiring'],
        ['2027-10-20T00:00:00Z', 'grace'],
        ['2027-11-01T00:00:00Z', 'expired'],
      ]
      for (const [now, state] of cases) {
        vi.setSystemTime(new Date(now))
        await startProcess({ ...VALID_ENV, PLATFORM_LICENSE: token })

        expect(licenseLines(), state).toEqual([expect.objectContaining({ state, licenseId: 'LIC-2026.0042' })])
        expectTokenNotPrinted(token)
        await expectStarted(state)
      }
    })

    it('logs the free tier without PLATFORM_LICENSE, and nothing about a license in cloud mode', async () => {
      await startProcess(VALID_ENV)
      expect(licenseLines()).toEqual([expect.objectContaining({ level: 'info', state: 'free' })])
      await expectStarted('free')

      await startProcess({ ...VALID_ENV, DEPLOYMENT_MODE: 'cloud', PLATFORM_LICENSE: 'ldl1.leaked-license-value' })
      expect(licenseLines()).toEqual([])
      expectTokenNotPrinted('ldl1.leaked-license-value')
    })
  })
})
