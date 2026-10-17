import { afterEach, describe, expect, it, vi } from 'vitest'
import { LICENSE_TEST_KEY, OTHER_LICENSE_TEST_KEY, signLicense } from '../../../../tests/license/test-keys'
import type { LicenseErrorCode } from './errors'
import type { LicenseKey, LicensePayload } from './token'

// The key list of the build, which each test sets; the real list never holds a test key (keys.test.ts).
const licenseKeys = vi.hoisted((): LicenseKey[] => [])
vi.mock('./keys', () => ({ LICENSE_KEYS: licenseKeys }))

const TEST_KEY_LIST: LicenseKey[] = [{ kid: LICENSE_TEST_KEY.kid, publicKey: LICENSE_TEST_KEY.publicKey }]

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
// The same license bound to the host of AUTH_URL below.
const BOUND: LicensePayload = { ...LICENSE, hosts: ['platform.example.test'] }

// An instant in each state of LICENSE, which is expiring from 2027-09-16, in grace from 2027-10-16 and expired from
// 2027-10-30.
const ACTIVE_AT = new Date('2027-01-01T00:00:00Z')
const EXPIRING_AT = new Date('2027-10-01T00:00:00Z')
const GRACE_AT = new Date('2027-10-20T00:00:00Z')
const EXPIRED_AT = new Date('2027-11-01T00:00:00Z')

const FREE_TIER = { adminSeats: 1, userSeats: 3 }

const CLOUD: Record<string, string> = {
  DEPLOYMENT_MODE: 'cloud',
  DATABASE_URL: 'postgresql://libredb_platform:db-password@db.internal:5432/libredb?schema=platform',
  AUTH_SECRET: 'auth-secret-value-of-at-least-32-characters',
  AUTH_URL: 'https://platform.example.test',
}

const SELF_HOSTED: Record<string, string> = {
  ...CLOUD,
  DEPLOYMENT_MODE: 'self-hosted',
  STUDIO_PUBLIC_URL: 'https://studio.example.test',
  AUTH_KEYCLOAK_ISSUER: 'https://auth.example.test/realms/libredb',
  AUTH_KEYCLOAK_ID: 'libredb-platform',
  AUTH_KEYCLOAK_SECRET: 'keycloak-client-secret-value',
  // Studio's seal public key: the recipient key of Studio's lsb1 test vectors, a published test key.
  BRIDGE_SEAL_PUBLIC_KEY: 'b6-f045B6re3Ue7V8Cr5jO9ApZzyOxGk659gM3tn5wE',
}

const VARIABLES = ['NODE_ENV', 'LOG_LEVEL', 'LOG_FORMAT', 'PLATFORM_LICENSE', ...Object.keys(SELF_HOSTED)]

/**
 * The license module of a new server process with this environment and key list, because Platform reads its
 * configuration and verifies its license once per process. Its logger writes JSON lines from info up.
 */
async function startProcess(env: Record<string, string | undefined>, keys: LicenseKey[] = TEST_KEY_LIST) {
  licenseKeys.splice(0, licenseKeys.length, ...keys)
  const values: Record<string, string | undefined> = { NODE_ENV: 'test', LOG_LEVEL: 'info', LOG_FORMAT: 'json', ...env }
  for (const name of VARIABLES) vi.stubEnv(name, values[name])
  vi.resetModules()
  return import('./install-license')
}

function sign(payload: LicensePayload): string {
  return signLicense(LICENSE_TEST_KEY, payload)
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('getLicenseStatus', () => {
  it('is null in cloud mode, where licensing does not apply, whatever PLATFORM_LICENSE holds', async () => {
    for (const token of [undefined, 'not a license', sign(LICENSE)]) {
      const { getLicenseStatus } = await startProcess({ ...CLOUD, PLATFORM_LICENSE: token })
      expect(getLicenseStatus(ACTIVE_AT)).toBeNull()
    }
  })

  it('is free in self-hosted mode without PLATFORM_LICENSE, and an empty value counts as unset', async () => {
    for (const token of [undefined, '']) {
      const { getLicenseStatus } = await startProcess({ ...SELF_HOSTED, PLATFORM_LICENSE: token })
      expect(getLicenseStatus(ACTIVE_AT)).toEqual({ state: 'free', limits: FREE_TIER })
    }
  })

  it('verifies PLATFORM_LICENSE against the key list of the build and the host of AUTH_URL', async () => {
    const valid = (license: LicensePayload) => ({ state: 'active', license, limits: { adminSeats: 2, userSeats: 25 } })
    const invalid = (code: LicenseErrorCode) => ({ state: 'invalid', code, limits: FREE_TIER })
    const cases: Array<[string, Record<string, string | undefined>, object]> = [
      ['a license bound to no host', { PLATFORM_LICENSE: sign(LICENSE) }, valid(LICENSE)],
      ['a license bound to no host, without AUTH_URL', { PLATFORM_LICENSE: sign(LICENSE), AUTH_URL: undefined }, valid(LICENSE)],
      ['a license bound to the host of AUTH_URL', { PLATFORM_LICENSE: sign(BOUND) }, valid(BOUND)],
      // URL#hostname lowercases the host and leaves out the port and the path.
      [
        'a license bound to the host of AUTH_URL, written in capitals with a port and a path',
        { PLATFORM_LICENSE: sign(BOUND), AUTH_URL: 'https://Platform.Example.TEST:8443/libredb' },
        valid(BOUND),
      ],
      [
        'a license bound to another host',
        { PLATFORM_LICENSE: sign(BOUND), AUTH_URL: 'https://studio.example.test' },
        invalid('LICENSE_HOST_MISMATCH'),
      ],
      [
        'a license bound to a host, without AUTH_URL',
        { PLATFORM_LICENSE: sign(BOUND), AUTH_URL: undefined },
        invalid('LICENSE_HOST_MISMATCH'),
      ],
      [
        'a token signed by a key the build does not hold',
        { PLATFORM_LICENSE: signLicense(OTHER_LICENSE_TEST_KEY, LICENSE) },
        invalid('LICENSE_UNKNOWN_KID'),
      ],
      ['a value that is no token', { PLATFORM_LICENSE: 'not a license' }, invalid('LICENSE_MALFORMED')],
    ]
    for (const [name, env, expected] of cases) {
      const { getLicenseStatus } = await startProcess({ ...SELF_HOSTED, ...env })
      expect(getLicenseStatus(ACTIVE_AT), name).toMatchObject(expected)
    }
  })

  it('computes the state from the clock on every read', async () => {
    const { getLicenseStatus } = await startProcess({ ...SELF_HOSTED, PLATFORM_LICENSE: sign(LICENSE) })
    expect([ACTIVE_AT, EXPIRING_AT, GRACE_AT, EXPIRED_AT, ACTIVE_AT].map((now) => getLicenseStatus(now)?.state)).toEqual([
      'active',
      'expiring',
      'grace',
      'expired',
      'active',
    ])

    // Without an instant, it reads the current time.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(GRACE_AT)
    expect(getLicenseStatus()?.state).toBe('grace')
  })

  it('verifies PLATFORM_LICENSE once per process, so a later read keeps the outcome of the first', async () => {
    const { getLicenseStatus } = await startProcess({ ...SELF_HOSTED, PLATFORM_LICENSE: sign(LICENSE) })
    expect(getLicenseStatus(ACTIVE_AT)?.state).toBe('active')

    // The same process without the key: a second verification would find no key for the kid of the token.
    licenseKeys.splice(0, licenseKeys.length)

    expect(getLicenseStatus(ACTIVE_AT)?.state).toBe('active')
  })

  it('throws the RangeError of the state for an instant that is not a valid date, in self-hosted mode only', async () => {
    const selfHosted = await startProcess({ ...SELF_HOSTED, PLATFORM_LICENSE: sign(LICENSE) })
    expect(() => selfHosted.getLicenseStatus(new Date(Number.NaN))).toThrow(RangeError)

    const cloud = await startProcess({ ...CLOUD, PLATFORM_LICENSE: sign(LICENSE) })
    expect(cloud.getLicenseStatus(new Date(Number.NaN))).toBeNull()
  })

  it('throws for a key list that is not valid, which is a defect of the build and not of any license', async () => {
    // The kid of one test key with the public key of the other.
    const defective = [{ kid: OTHER_LICENSE_TEST_KEY.kid, publicKey: LICENSE_TEST_KEY.publicKey }]
    const { getLicenseStatus } = await startProcess({ ...SELF_HOSTED, PLATFORM_LICENSE: sign(LICENSE) }, defective)
    expect(() => getLicenseStatus(ACTIVE_AT)).toThrow('License key 0 has a kid that is not derived from its public key')
  })
})

describe('logLicenseStatus', () => {
  // The lines printed on every console method, parsed, without their timestamps.
  function printedLines(): Array<Record<string, unknown>> {
    return [console.debug, console.log, console.warn, console.error]
      .flatMap((method) => vi.mocked(method).mock.calls)
      .map((call) => {
        const { timestamp, ...line } = JSON.parse(String(call[0]))
        expect(timestamp).toEqual(expect.any(String))
        return line
      })
  }

  // No printed text holds the token, nor its payload or signature.
  function expectTokenNotPrinted(token: string) {
    const text = [console.debug, console.log, console.warn, console.error]
      .flatMap((method) => vi.mocked(method).mock.calls.flat())
      .join('\n')
    for (const part of [token, ...token.split('.').filter((segment) => segment.length > 16)]) {
      expect(text).not.toContain(part)
    }
  }

  function silenceConsole() {
    for (const method of ['debug', 'log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation(() => {})
    }
  }

  it('logs one line with the state, and the id, customer and expiry of a valid license', async () => {
    const expiry = { licenseId: 'LIC-2026.0042', customer: 'Example Customer', expiresAt: '2027-10-16T00:00:00.000Z' }
    const cases: Array<[Date, Record<string, unknown>]> = [
      [ACTIVE_AT, { level: 'info', message: 'License active', state: 'active', ...expiry }],
      [EXPIRING_AT, { level: 'warn', message: 'License expiring within 30 days', state: 'expiring', ...expiry }],
      [GRACE_AT, { level: 'warn', message: 'License expired, in its 14-day grace period', state: 'grace', ...expiry }],
      [EXPIRED_AT, { level: 'warn', message: 'License expired, no seat can be added', state: 'expired', ...expiry }],
    ]
    vi.useFakeTimers({ toFake: ['Date'] })
    for (const [now, line] of cases) {
      vi.setSystemTime(now)
      silenceConsole()
      const token = sign(LICENSE)
      const { logLicenseStatus } = await startProcess({ ...SELF_HOSTED, PLATFORM_LICENSE: token })

      logLicenseStatus()

      expect(printedLines(), String(line.state)).toEqual([line])
      expectTokenNotPrinted(token)
      vi.restoreAllMocks()
    }
  })

  it('logs one line with the state and code of a token that fails verification, and never the token', async () => {
    // A valid token whose payload was changed to give more seats, under the signature of the original.
    const [prefix, kid, , signature] = sign(LICENSE).split('.')
    const tampered = [prefix, kid, Buffer.from(JSON.stringify({ ...LICENSE, userSeats: 2500 })).toString('base64url'), signature]
    const cases: Array<[string, LicenseErrorCode]> = [
      ['ldl1.leaked-license-value', 'LICENSE_MALFORMED'],
      [signLicense(OTHER_LICENSE_TEST_KEY, LICENSE), 'LICENSE_UNKNOWN_KID'],
      [tampered.join('.'), 'LICENSE_BAD_SIGNATURE'],
      [sign(BOUND), 'LICENSE_HOST_MISMATCH'],
    ]
    for (const [token, code] of cases) {
      silenceConsole()
      const env = { ...SELF_HOSTED, PLATFORM_LICENSE: token, AUTH_URL: 'https://studio.example.test' }
      const { logLicenseStatus } = await startProcess(env)

      logLicenseStatus()

      expect(printedLines(), code).toEqual([
        { level: 'warn', message: 'License invalid, running on the free tier', state: 'invalid', code },
      ])
      expectTokenNotPrinted(token)
      vi.restoreAllMocks()
    }
  })

  it('logs one line with the free tier without PLATFORM_LICENSE, and nothing in cloud mode', async () => {
    silenceConsole()
    const selfHosted = await startProcess(SELF_HOSTED)
    selfHosted.logLicenseStatus()
    expect(printedLines()).toEqual([{ level: 'info', message: 'No license, running on the free tier', state: 'free' }])
    vi.restoreAllMocks()

    silenceConsole()
    const cloud = await startProcess({ ...CLOUD, PLATFORM_LICENSE: sign(LICENSE) })
    cloud.logLicenseStatus()
    expect(printedLines()).toEqual([])
  })

  it('logs the failure and returns for a key list that is not valid, so the start goes on', async () => {
    silenceConsole()
    const defective = [{ kid: OTHER_LICENSE_TEST_KEY.kid, publicKey: LICENSE_TEST_KEY.publicKey }]
    const token = sign(LICENSE)
    const { logLicenseStatus } = await startProcess({ ...SELF_HOSTED, PLATFORM_LICENSE: token }, defective)

    expect(() => logLicenseStatus()).not.toThrow()

    expect(printedLines()).toEqual([
      {
        level: 'error',
        message: 'Reading the license failed',
        error: { message: 'License key 0 has a kid that is not derived from its public key', stack: expect.any(String) },
      },
    ])
    expectTokenNotPrinted(token)
    expectTokenNotPrinted(LICENSE_TEST_KEY.publicKey)
  })
})
