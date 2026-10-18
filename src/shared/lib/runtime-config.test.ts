import { afterEach, describe, it, expect, vi } from 'vitest'
import { readRuntimeConfig, type RuntimeEnv } from './runtime-config'
import { ConfigError } from './errors'

const DATABASE_URL = 'postgresql://libredb_platform:db-password-value@db.internal:5432/libredb?schema=platform'
const AUTH_SECRET = 'auth-secret-value-of-at-least-32-characters'

const CLOUD: RuntimeEnv = {
  DEPLOYMENT_MODE: 'cloud',
  DATABASE_URL,
  AUTH_SECRET,
}

const KEYCLOAK = {
  AUTH_KEYCLOAK_ISSUER: 'https://auth.example.test/realms/libredb',
  AUTH_KEYCLOAK_ID: 'libredb-platform',
  AUTH_KEYCLOAK_SECRET: 'keycloak-client-secret-value',
}

// Studio's seal public key: the recipient key of Studio's lsb1 test vectors, a published test key.
const BRIDGE_SEAL_PUBLIC_KEY = 'b6-f045B6re3Ue7V8Cr5jO9ApZzyOxGk659gM3tn5wE'

// A value in the form of a license token that no key signed; the schema passes it on, and the license module verifies it.
const PLATFORM_LICENSE = 'ldl1.0123456789abcdef.e30.AA'

const SELF_HOSTED: RuntimeEnv = {
  ...CLOUD,
  DEPLOYMENT_MODE: 'self-hosted',
  STUDIO_PUBLIC_URL: 'https://studio.example.test',
  ...KEYCLOAK,
  BRIDGE_SEAL_PUBLIC_KEY,
  PLATFORM_LICENSE,
}

// The flat ID-token claim and the Keycloak roles that every install uses unless it overrides them.
const ROLE_DEFAULTS = {
  PLATFORM_ROLE_CLAIM: 'libredb_roles',
  PLATFORM_ADMIN_ROLE: 'admin',
  STUDIO_USER_ROLE: 'user',
}

// The default session recheck: every 300 s, with a grace of 900 s while the Keycloak Admin API cannot be read.
const RECHECK_DEFAULTS = {
  PLATFORM_SESSION_RECHECK_SECONDS: 300,
  PLATFORM_RECHECK_GRACE_SECONDS: 900,
}

function configError(env: RuntimeEnv): ConfigError {
  try {
    readRuntimeConfig(env)
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('expected a ConfigError')
}

describe('readRuntimeConfig', () => {
  it('returns the validated variables of a complete configuration in each mode', () => {
    expect(readRuntimeConfig({ ...CLOUD, NODE_ENV: 'production', AUTH_URL: 'https://platform.example.test', PATH: '/usr/bin' })).toEqual({
      DEPLOYMENT_MODE: 'cloud',
      DATABASE_URL,
      AUTH_SECRET,
      AUTH_URL: 'https://platform.example.test',
      ...ROLE_DEFAULTS,
      ...RECHECK_DEFAULTS,
      QUERY_LOG_RETENTION_DAYS: 90,
      DIRECTORY_SYNC_INTERVAL_SEC: 60,
    })
    expect(readRuntimeConfig(SELF_HOSTED)).toEqual({
      DEPLOYMENT_MODE: 'self-hosted',
      DATABASE_URL,
      AUTH_SECRET,
      STUDIO_PUBLIC_URL: 'https://studio.example.test',
      ...KEYCLOAK,
      BRIDGE_SEAL_PUBLIC_KEY,
      PLATFORM_LICENSE,
      ...ROLE_DEFAULTS,
      ...RECHECK_DEFAULTS,
      QUERY_LOG_RETENTION_DAYS: 90,
      DIRECTORY_SYNC_INTERVAL_SEC: 60,
    })
  })

  it('reports every missing variable in one error, by name only', () => {
    const empty = configError({ NODE_ENV: 'production' })
    for (const name of ['DEPLOYMENT_MODE', 'DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL']) {
      expect(empty.message).toContain(name)
    }

    const values = {
      NODE_ENV: 'production',
      DEPLOYMENT_MODE: 'self-hosted',
      DATABASE_URL: 'mysql://root:leaked-db-password@db.internal/libredb',
      AUTH_SECRET: 'leaked-short-secret',
    }
    const error = configError(values)
    for (const name of [
      'DATABASE_URL',
      'AUTH_SECRET',
      'AUTH_URL',
      'STUDIO_PUBLIC_URL',
      'AUTH_KEYCLOAK_ISSUER',
      'AUTH_KEYCLOAK_ID',
      'AUTH_KEYCLOAK_SECRET',
      'BRIDGE_SEAL_PUBLIC_KEY',
      'PLATFORM_LICENSE',
    ]) {
      expect(error.message).toContain(name)
    }
    expect(error.message).not.toContain('DEPLOYMENT_MODE')
    expect(error.message).not.toContain('leaked')
    expect(error.message).not.toContain('mysql')
  })

  it('treats an empty value as unset', () => {
    expect(configError({ ...CLOUD, DEPLOYMENT_MODE: '' }).message).toMatch(/DEPLOYMENT_MODE is required/)
    expect(readRuntimeConfig({ ...CLOUD, STUDIO_PUBLIC_URL: '' }).STUDIO_PUBLIC_URL).toBeUndefined()
  })

  it('rejects a DEPLOYMENT_MODE other than cloud or self-hosted', () => {
    const error = configError({ ...CLOUD, DEPLOYMENT_MODE: 'bogus-mode' })

    expect(error.message).toMatch(/DEPLOYMENT_MODE must be "cloud" or "self-hosted"/)
    expect(error.message).not.toContain('bogus-mode')
  })

  it('rejects a DATABASE_URL that is not a postgresql:// URL', () => {
    for (const value of ['mysql://u:p@db/libredb', 'postgres://u:p@db/libredb', 'postgresql:libredb', 'db.internal:5432/libredb']) {
      expect(configError({ ...CLOUD, DATABASE_URL: value }).message).toMatch(/DATABASE_URL must be a postgresql:\/\/ URL/)
    }
  })

  it('refuses a DATABASE_URL without schema=platform', () => {
    const base = 'postgresql://libredb_platform:db-password-value@db.internal:5432/libredb'
    for (const value of [base, `${base}?schema=public`, `${base}?sslmode=verify-full`, `${base}?schema=platform&schema=public`]) {
      const error = configError({ ...CLOUD, DATABASE_URL: value })
      expect(error.message).toMatch(/DATABASE_URL must include schema=platform/)
      expect(error.message).not.toContain('db-password-value')
    }

    // A URL that is not a postgresql:// URL reports that problem alone.
    expect(configError({ ...CLOUD, DATABASE_URL: 'mysql://u:p@db/libredb' }).message).not.toMatch(/schema=platform/)

    const tls = `${base}?sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt&schema=platform`
    expect(readRuntimeConfig({ ...CLOUD, DATABASE_URL: tls }).DATABASE_URL).toBe(tls)
  })

  it('rejects an AUTH_SECRET shorter than 32 characters', () => {
    expect(configError({ ...CLOUD, AUTH_SECRET: 'a'.repeat(31) }).message).toMatch(/AUTH_SECRET must be at least 32 characters/)
    expect(readRuntimeConfig({ ...CLOUD, AUTH_SECRET: 'a'.repeat(32) }).AUTH_SECRET).toBe('a'.repeat(32))
  })

  it('accepts an optional AUTH_SECRET_PREVIOUS of at least 32 characters', () => {
    const previous = 'previous-auth-secret-of-at-least-32-characters'
    expect(readRuntimeConfig(CLOUD).AUTH_SECRET_PREVIOUS).toBeUndefined()
    expect(readRuntimeConfig({ ...CLOUD, AUTH_SECRET_PREVIOUS: '' }).AUTH_SECRET_PREVIOUS).toBeUndefined()
    expect(readRuntimeConfig({ ...CLOUD, AUTH_SECRET_PREVIOUS: previous }).AUTH_SECRET_PREVIOUS).toBe(previous)

    const error = configError({ ...CLOUD, AUTH_SECRET_PREVIOUS: 'leaked-short-previous' })
    expect(error.message).toMatch(/AUTH_SECRET_PREVIOUS must be at least 32 characters/)
    expect(error.message).not.toContain('leaked')
  })

  it('refuses an AUTH_SECRET_PREVIOUS equal to AUTH_SECRET', () => {
    const error = configError({ ...CLOUD, AUTH_SECRET_PREVIOUS: AUTH_SECRET })

    expect(error.message).toMatch(/AUTH_SECRET_PREVIOUS must differ from AUTH_SECRET/)
    expect(error.message).not.toContain(AUTH_SECRET)
  })

  it('requires AUTH_URL when NODE_ENV is production', () => {
    expect(configError({ ...CLOUD, NODE_ENV: 'production' }).message).toMatch(/AUTH_URL is required when NODE_ENV is production/)
    expect(readRuntimeConfig({ ...CLOUD, NODE_ENV: 'development' }).AUTH_URL).toBeUndefined()
    expect(readRuntimeConfig({ ...CLOUD, NODE_ENV: 'production', AUTH_URL: 'http://platform.internal:3000' }).AUTH_URL)
      .toBe('http://platform.internal:3000')

    for (const value of ['/platform', 'platform.example.test', 'ftp://platform.example.test']) {
      expect(configError({ ...CLOUD, NODE_ENV: 'development', AUTH_URL: value }).message)
        .toMatch(/AUTH_URL must be an absolute http\(s\) URL/)
    }
  })

  it('requires STUDIO_PUBLIC_URL in self-hosted mode only', () => {
    expect(configError({ ...SELF_HOSTED, STUDIO_PUBLIC_URL: undefined }).message)
      .toMatch(/STUDIO_PUBLIC_URL is required in self-hosted mode/)
    expect(readRuntimeConfig(CLOUD).STUDIO_PUBLIC_URL).toBeUndefined()
    expect(readRuntimeConfig({ ...CLOUD, STUDIO_PUBLIC_URL: 'http://localhost:3001' }).STUDIO_PUBLIC_URL)
      .toBe('http://localhost:3001')

    for (const env of [SELF_HOSTED, CLOUD]) {
      for (const value of ['studio.example.test', '/studio', 'javascript:alert(1)']) {
        expect(configError({ ...env, STUDIO_PUBLIC_URL: value }).message)
          .toMatch(/STUDIO_PUBLIC_URL must be an absolute http\(s\) URL/)
      }
    }
  })

  it('requires BRIDGE_SEAL_PUBLIC_KEY in self-hosted mode only', () => {
    for (const value of [undefined, '']) {
      expect(configError({ ...SELF_HOSTED, BRIDGE_SEAL_PUBLIC_KEY: value }).message)
        .toContain('BRIDGE_SEAL_PUBLIC_KEY is required in self-hosted mode')
    }
    expect(readRuntimeConfig(CLOUD).BRIDGE_SEAL_PUBLIC_KEY).toBeUndefined()
    expect(readRuntimeConfig({ ...CLOUD, BRIDGE_SEAL_PUBLIC_KEY }).BRIDGE_SEAL_PUBLIC_KEY).toBe(BRIDGE_SEAL_PUBLIC_KEY)

    // The unpadded base64url of 31 and 33 bytes, padded base64url, standard base64 and hex are no key in either mode.
    const raw = Buffer.from(BRIDGE_SEAL_PUBLIC_KEY, 'base64url')
    for (const env of [SELF_HOSTED, CLOUD]) {
      for (const value of [
        raw.subarray(1).toString('base64url'),
        Buffer.concat([raw, Buffer.of(7)]).toString('base64url'),
        `${BRIDGE_SEAL_PUBLIC_KEY}=`,
        raw.toString('base64'),
        raw.toString('hex'),
      ]) {
        const error = configError({ ...env, BRIDGE_SEAL_PUBLIC_KEY: value })
        expect(error.message).toContain('BRIDGE_SEAL_PUBLIC_KEY must be the unpadded base64url of a raw 32-byte X25519 public key')
        expect(error.message).not.toContain(value)
      }
    }
  })

  it('requires AUTH_KEYCLOAK_ISSUER, AUTH_KEYCLOAK_ID and AUTH_KEYCLOAK_SECRET in self-hosted mode only', () => {
    for (const name of ['AUTH_KEYCLOAK_ISSUER', 'AUTH_KEYCLOAK_ID', 'AUTH_KEYCLOAK_SECRET']) {
      for (const value of [undefined, '']) {
        expect(configError({ ...SELF_HOSTED, [name]: value }).message).toContain(`${name} is required in self-hosted mode`)
      }
    }

    const cloud = readRuntimeConfig(CLOUD)
    expect(cloud.AUTH_KEYCLOAK_ISSUER).toBeUndefined()
    expect(cloud.AUTH_KEYCLOAK_ID).toBeUndefined()
    expect(cloud.AUTH_KEYCLOAK_SECRET).toBeUndefined()
    expect(readRuntimeConfig({ ...CLOUD, ...KEYCLOAK })).toMatchObject(KEYCLOAK)

    const error = configError({ ...SELF_HOSTED, AUTH_KEYCLOAK_ISSUER: undefined, AUTH_KEYCLOAK_ID: undefined })
    expect(error.message).not.toContain('keycloak-client-secret-value')
  })

  it('checks the realm path of AUTH_KEYCLOAK_ISSUER and the optional KEYCLOAK_ADMIN_URL in both modes', () => {
    for (const env of [SELF_HOSTED, { ...CLOUD, ...KEYCLOAK }]) {
      expect(readRuntimeConfig(env).KEYCLOAK_ADMIN_URL).toBeUndefined()
      expect(readRuntimeConfig({ ...env, KEYCLOAK_ADMIN_URL: 'http://keycloak:8080' }).KEYCLOAK_ADMIN_URL)
        .toBe('http://keycloak:8080')

      for (const value of ['https://auth.example.test', 'https://auth.example.test/realms/libredb/', 'auth.example.test/realms/libredb']) {
        const error = configError({ ...env, AUTH_KEYCLOAK_ISSUER: value })
        expect(error.message).toMatch(/AUTH_KEYCLOAK_ISSUER must be an absolute http\(s\) URL ending in \/realms\/<realm>/)
        expect(error.message).not.toContain('auth.example.test')
      }
      for (const value of ['keycloak:8080', '/keycloak', 'ftp://keycloak:8080', 'http://keycloak:8080/?realm=libredb']) {
        expect(configError({ ...env, KEYCLOAK_ADMIN_URL: value }).message)
          .toMatch(/KEYCLOAK_ADMIN_URL must be an absolute http\(s\) URL/)
      }
    }
  })

  it('PLATFORM_ROLE_CLAIM, PLATFORM_ADMIN_ROLE and STUDIO_USER_ROLE default to libredb_roles, admin and user', () => {
    for (const env of [CLOUD, SELF_HOSTED]) {
      expect(readRuntimeConfig(env)).toMatchObject(ROLE_DEFAULTS)
      expect(readRuntimeConfig({ ...env, PLATFORM_ROLE_CLAIM: '', PLATFORM_ADMIN_ROLE: '', STUDIO_USER_ROLE: '' }))
        .toMatchObject(ROLE_DEFAULTS)
    }

    const custom = { PLATFORM_ROLE_CLAIM: 'platform_roles', PLATFORM_ADMIN_ROLE: 'dba', STUDIO_USER_ROLE: 'analyst' }
    expect(readRuntimeConfig({ ...SELF_HOSTED, ...custom })).toMatchObject(custom)
  })

  it('PLATFORM_ROLE_CLAIM, PLATFORM_ADMIN_ROLE and STUDIO_USER_ROLE must not start or end with a space', () => {
    for (const name of ['PLATFORM_ROLE_CLAIM', 'PLATFORM_ADMIN_ROLE', 'STUDIO_USER_ROLE']) {
      for (const value of [' leaked-name', 'leaked-name ', '\tleaked-name']) {
        const error = configError({ ...SELF_HOSTED, [name]: value })
        expect(error.message).toContain(`${name} must not start or end with a space`)
        expect(error.message).not.toContain('leaked')
      }
    }
    // A claim name is read as one flat claim, so a namespaced name is taken as it is and a dot never means a path.
    for (const value of ['https://libredb.test/roles', 'realm_access.roles']) {
      expect(readRuntimeConfig({ ...SELF_HOSTED, PLATFORM_ROLE_CLAIM: value }).PLATFORM_ROLE_CLAIM).toBe(value)
    }
  })

  it('PLATFORM_ADMIN_ROLE must differ from STUDIO_USER_ROLE', () => {
    for (const env of [CLOUD, SELF_HOSTED]) {
      expect(configError({ ...env, PLATFORM_ADMIN_ROLE: 'user' }).message).toMatch(/PLATFORM_ADMIN_ROLE must differ from STUDIO_USER_ROLE/)
      expect(configError({ ...env, PLATFORM_ADMIN_ROLE: 'member', STUDIO_USER_ROLE: 'member' }).message)
        .toMatch(/PLATFORM_ADMIN_ROLE must differ from STUDIO_USER_ROLE/)
    }
  })

  it('PLATFORM_SESSION_RECHECK_SECONDS and PLATFORM_RECHECK_GRACE_SECONDS must be positive integers', () => {
    for (const env of [CLOUD, SELF_HOSTED]) {
      expect(readRuntimeConfig(env)).toMatchObject(RECHECK_DEFAULTS)
      expect(readRuntimeConfig({ ...env, PLATFORM_SESSION_RECHECK_SECONDS: '', PLATFORM_RECHECK_GRACE_SECONDS: '' }))
        .toMatchObject(RECHECK_DEFAULTS)
    }
    // The self-hosted end-to-end run rechecks every 2 s; a day is the longest interval and the longest grace.
    expect(readRuntimeConfig({ ...SELF_HOSTED, PLATFORM_SESSION_RECHECK_SECONDS: '2', PLATFORM_RECHECK_GRACE_SECONDS: '1' }))
      .toMatchObject({ PLATFORM_SESSION_RECHECK_SECONDS: 2, PLATFORM_RECHECK_GRACE_SECONDS: 1 })
    expect(readRuntimeConfig({ ...SELF_HOSTED, PLATFORM_SESSION_RECHECK_SECONDS: '86400', PLATFORM_RECHECK_GRACE_SECONDS: '86400' }))
      .toMatchObject({ PLATFORM_SESSION_RECHECK_SECONDS: 86400, PLATFORM_RECHECK_GRACE_SECONDS: 86400 })

    for (const name of ['PLATFORM_SESSION_RECHECK_SECONDS', 'PLATFORM_RECHECK_GRACE_SECONDS']) {
      for (const value of ['0', '-1', '1.5', '300s', ' 300', '1e3', '0x10', '0300', 'five', '86401', '99999999999']) {
        expect(configError({ ...SELF_HOSTED, [name]: value }).message).toContain(`${name} must be a positive integer of at most 86400`)
      }
    }
  })

  it('QUERY_LOG_RETENTION_DAYS must be a positive integer', () => {
    expect(readRuntimeConfig(CLOUD).QUERY_LOG_RETENTION_DAYS).toBe(90)
    expect(readRuntimeConfig({ ...CLOUD, QUERY_LOG_RETENTION_DAYS: '' }).QUERY_LOG_RETENTION_DAYS).toBe(90)
    // The database still keeps every event younger than 7 days whatever the value.
    expect(readRuntimeConfig({ ...CLOUD, QUERY_LOG_RETENTION_DAYS: '1' }).QUERY_LOG_RETENTION_DAYS).toBe(1)
    expect(readRuntimeConfig({ ...CLOUD, QUERY_LOG_RETENTION_DAYS: '365' }).QUERY_LOG_RETENTION_DAYS).toBe(365)
    expect(readRuntimeConfig({ ...CLOUD, QUERY_LOG_RETENTION_DAYS: '36500' }).QUERY_LOG_RETENTION_DAYS).toBe(36500)

    for (const value of ['0', '-1', '1.5', '90d', ' 90', '1e2', '0x10', '036', 'ninety', '36501', '99999999999']) {
      expect(configError({ ...CLOUD, QUERY_LOG_RETENTION_DAYS: value }).message)
        .toMatch(/QUERY_LOG_RETENTION_DAYS must be a positive integer of at most 36500/)
    }
  })

  it('DIRECTORY_SYNC_INTERVAL_SEC must be a positive integer of at most 86400', () => {
    for (const env of [CLOUD, SELF_HOSTED]) {
      expect(readRuntimeConfig(env).DIRECTORY_SYNC_INTERVAL_SEC).toBe(60)
      expect(readRuntimeConfig({ ...env, DIRECTORY_SYNC_INTERVAL_SEC: '' }).DIRECTORY_SYNC_INTERVAL_SEC).toBe(60)
    }
    // An end-to-end run may sync every second; a day is the longest interval.
    expect(readRuntimeConfig({ ...SELF_HOSTED, DIRECTORY_SYNC_INTERVAL_SEC: '1' }).DIRECTORY_SYNC_INTERVAL_SEC).toBe(1)
    expect(readRuntimeConfig({ ...SELF_HOSTED, DIRECTORY_SYNC_INTERVAL_SEC: '86400' }).DIRECTORY_SYNC_INTERVAL_SEC).toBe(86400)

    for (const value of ['0', '-1', '1.5', '60s', ' 60', '1e2', '0x10', '060', 'sixty', '86401', '99999999999']) {
      expect(configError({ ...SELF_HOSTED, DIRECTORY_SYNC_INTERVAL_SEC: value }).message)
        .toContain('DIRECTORY_SYNC_INTERVAL_SEC must be a positive integer of at most 86400')
    }
  })

  it('requires PLATFORM_LICENSE in self-hosted mode only, and refuses no value of it', () => {
    for (const value of [undefined, '']) {
      expect(configError({ ...SELF_HOSTED, PLATFORM_LICENSE: value }).message).toBe(
        'Invalid runtime configuration: PLATFORM_LICENSE is required in self-hosted mode',
      )
    }
    expect(readRuntimeConfig(CLOUD).PLATFORM_LICENSE).toBeUndefined()
    expect(readRuntimeConfig({ ...CLOUD, PLATFORM_LICENSE: '' }).PLATFORM_LICENSE).toBeUndefined()

    // The license module verifies the token, and a token that fails verification never stops the start, so the
    // configuration passes every value on unchanged, even one that is no token at all.
    for (const env of [CLOUD, SELF_HOSTED]) {
      for (const value of [PLATFORM_LICENSE, 'ldl2.another-format', 'not a license', ' ldl1 ', 'x'.repeat(100_000)]) {
        expect(readRuntimeConfig({ ...env, PLATFORM_LICENSE: value }).PLATFORM_LICENSE).toBe(value)
      }
    }

    // Another invalid variable reports itself alone, without naming the license or repeating its value.
    const error = configError({ ...SELF_HOSTED, AUTH_SECRET: 'short', PLATFORM_LICENSE: 'leaked-license-value' })
    expect(error.message).toMatch(/AUTH_SECRET must be at least 32 characters/)
    expect(error.message).not.toContain('PLATFORM_LICENSE')
    expect(error.message).not.toContain('leaked')
  })
})

describe('getRuntimeConfig', () => {
  function stubEnv(env: RuntimeEnv) {
    for (const name of [
      'NODE_ENV',
      'DEPLOYMENT_MODE',
      'DATABASE_URL',
      'AUTH_SECRET',
      'AUTH_SECRET_PREVIOUS',
      'AUTH_URL',
      'STUDIO_PUBLIC_URL',
      'AUTH_KEYCLOAK_ISSUER',
      'AUTH_KEYCLOAK_ID',
      'AUTH_KEYCLOAK_SECRET',
      'KEYCLOAK_ADMIN_URL',
      'BRIDGE_SEAL_PUBLIC_KEY',
      'PLATFORM_ROLE_CLAIM',
      'PLATFORM_ADMIN_ROLE',
      'STUDIO_USER_ROLE',
      'PLATFORM_SESSION_RECHECK_SECONDS',
      'PLATFORM_RECHECK_GRACE_SECONDS',
      'QUERY_LOG_RETENTION_DAYS',
      'DIRECTORY_SYNC_INTERVAL_SEC',
    ]) {
      vi.stubEnv(name, env[name])
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('validates process.env on first use and returns the same configuration afterwards', async () => {
    stubEnv({ ...CLOUD, NODE_ENV: 'test' })
    vi.resetModules()
    const { getRuntimeConfig } = await import('./runtime-config')

    const config = getRuntimeConfig()
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')

    expect(config.DEPLOYMENT_MODE).toBe('cloud')
    expect(getRuntimeConfig()).toBe(config)
  })

  it('throws ConfigError for an invalid process.env and keeps no result', async () => {
    stubEnv({ ...CLOUD, NODE_ENV: 'test', DEPLOYMENT_MODE: 'bogus-mode' })
    vi.resetModules()
    const { getRuntimeConfig } = await import('./runtime-config')
    const { ConfigError: FreshConfigError } = await import('./errors')

    expect(() => getRuntimeConfig()).toThrow(FreshConfigError)
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    expect(getRuntimeConfig().DEPLOYMENT_MODE).toBe('cloud')
  })
})
