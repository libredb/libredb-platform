// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHECKS, PreflightError, pgConfigFromPrismaUrl, runPreflight } from './preflight.mjs'

const MIGRATE_URL = 'postgresql://libredb_owner:owner%40pw@db.internal:5433/libredb?schema=platform'
const DATABASE_URL = 'postgresql://libredb_platform:platform-pw@db.internal:5433/libredb?schema=platform'
const ENV = { MIGRATE_DATABASE_URL: MIGRATE_URL, DATABASE_URL }

interface ServerState {
  versionNum: string
  standby: boolean
  owner: string
  roles: string[]
}

const HEALTHY: ServerState = {
  versionNum: '170004',
  standby: false,
  owner: 'libredb_owner',
  roles: ['libredb_platform', 'libredb_studio'],
}

/** A pg client that answers the preflight's statements from `state` and records the configuration it was opened with. */
function fakeServer(state: Partial<ServerState> = {}) {
  const server = { ...HEALTHY, ...state }
  const opened: unknown[] = []
  let ended = 0
  const connect = async (config: unknown) => {
    opened.push(config)
    return {
      async query(text: string) {
        if (text.includes('server_version_num')) return { rows: [{ version: server.versionNum }] }
        if (text.includes('pg_is_in_recovery')) return { rows: [{ standby: server.standby }] }
        if (text.includes('datdba')) return { rows: [{ owner: server.owner, role: 'libredb_owner' }] }
        if (text.includes('pg_roles')) return { rows: server.roles.map(rolname => ({ rolname })) }
        throw new Error(`unexpected statement: ${text}`)
      },
      async end() {
        ended += 1
      },
    }
  }
  return { connect, opened, ended: () => ended }
}

async function failedCheck(env: Record<string, string | undefined>, state: Partial<ServerState> = {}) {
  const server = fakeServer(state)
  const error = await runPreflight(env, server.connect).then(() => null, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(PreflightError)
  const failure = error as PreflightError
  // The message names the check and never repeats a URL, which carries a password.
  expect(failure.message).toContain(failure.check)
  expect(failure.message).not.toContain('pw')
  return { check: failure.check, message: failure.message, server }
}

describe('docker/migrator/preflight.mjs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'migrator-preflight-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes a healthy primary and closes its connection', async () => {
    const server = fakeServer()
    await expect(runPreflight(ENV, server.connect)).resolves.toBeUndefined()
    expect(server.opened).toHaveLength(1)
    expect(server.ended()).toBe(1)
  })

  it('refuses a URL without schema=platform, PostgreSQL 14, a standby and missing runtime roles, naming each check', async () => {
    for (const env of [
      { DATABASE_URL },
      { MIGRATE_DATABASE_URL: MIGRATE_URL },
      { MIGRATE_DATABASE_URL: '', DATABASE_URL },
    ]) {
      const { check, server } = await failedCheck(env)
      expect(check).toBe(CHECKS.urlsSet)
      expect(server.opened).toEqual([])
    }

    for (const env of [
      { ...ENV, MIGRATE_DATABASE_URL: MIGRATE_URL.replace('?schema=platform', '') },
      { ...ENV, MIGRATE_DATABASE_URL: MIGRATE_URL.replace('schema=platform', 'schema=public') },
      { ...ENV, DATABASE_URL: DATABASE_URL.replace('?schema=platform', '') },
    ]) {
      const { check, message, server } = await failedCheck(env)
      expect(check).toBe(CHECKS.schema)
      expect(message).toMatch(env.DATABASE_URL === DATABASE_URL ? /MIGRATE_DATABASE_URL/ : /DATABASE_URL/)
      expect(server.opened).toEqual([])
    }

    const notUrl = await failedCheck({ ...ENV, MIGRATE_DATABASE_URL: 'mysql://root:pw@db/libredb?schema=platform' })
    expect(notUrl.check).toBe(CHECKS.urls)

    const old = await failedCheck(ENV, { versionNum: '140011' })
    expect(old.check).toBe(CHECKS.version)
    expect(old.message).toContain('14.11')
    expect(old.server.ended()).toBe(1)

    const standby = await failedCheck(ENV, { standby: true })
    expect(standby.check).toBe(CHECKS.primary)

    const notOwner = await failedCheck(ENV, { owner: 'postgres' })
    expect(notOwner.check).toBe(CHECKS.owner)
    expect(notOwner.message).toContain('postgres')

    const roles = await failedCheck(ENV, { roles: ['libredb_platform'] })
    expect(roles.check).toBe(CHECKS.roles)
    expect(roles.message).toContain('libredb_studio')
    expect(roles.message).not.toContain('libredb_platform,')
  })

  it('a Prisma-syntax MIGRATE_DATABASE_URL with sslcert and sslaccept=strict connects with that CA and verify-full', async () => {
    const ca = path.join(dir, 'ca.crt')
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\ntest CA\n-----END CERTIFICATE-----\n')
    const url = `${MIGRATE_URL}&sslmode=require&sslcert=${encodeURIComponent(ca)}&sslaccept=strict`

    const config = pgConfigFromPrismaUrl(url)
    expect(config).toMatchObject({
      host: 'db.internal',
      port: 5433,
      user: 'libredb_owner',
      password: 'owner@pw',
      database: 'libredb',
    })
    // verify-full: the chain must lead to the CA and the certificate must name the host; Node checks the name by default.
    expect(config.ssl).toEqual({ ca: '-----BEGIN CERTIFICATE-----\ntest CA\n-----END CERTIFICATE-----\n', rejectUnauthorized: true })

    // TLS follows sslcert and sslaccept without sslmode as well, as Prisma uses TLS whenever the server offers it.
    expect(pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslcert=${ca}&sslaccept=strict`).ssl).toEqual(config.ssl)

    // The preflight opens its connection with exactly that configuration.
    const server = fakeServer()
    await runPreflight({ ...ENV, MIGRATE_DATABASE_URL: url }, server.connect)
    expect(server.opened).toEqual([config])
  })

  it('derives the other Prisma TLS settings and refuses what it cannot honour', () => {
    expect(pgConfigFromPrismaUrl(MIGRATE_URL).ssl).toBe(false)
    expect(pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslmode=disable`).ssl).toBe(false)
    expect(pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslmode=prefer`).ssl).toBe(false)
    // Prisma's default sslaccept is accept_invalid_certs, which the preflight mirrors.
    expect(pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslmode=require`).ssl).toEqual({ rejectUnauthorized: false })
    // Without sslcert, strict verification uses the system CAs and NODE_EXTRA_CA_CERTS.
    expect(pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslmode=require&sslaccept=strict`).ssl).toEqual({ rejectUnauthorized: true })

    expect(() => pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslmode=require&sslcert=ca.crt`)).toThrow(/sslcert must be an absolute path/)
    expect(() => pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslmode=require&sslcert=${dir}/missing.crt`)).toThrow(/sslcert/)
    expect(() => pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslmode=require&sslidentity=/id.p12`)).toThrow(/sslidentity/)
    expect(() => pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslmode=verify-full`)).toThrow(/sslmode/)
    expect(() => pgConfigFromPrismaUrl(`${MIGRATE_URL}&sslaccept=sometimes`)).toThrow(/sslaccept/)
  })

  it('exits 1 naming the failed check when run as the entry point', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'preflight.mjs')], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: process.env.PATH, DATABASE_URL },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(CHECKS.urlsSet)
    expect(result.stderr).not.toContain('platform-pw')
  })
})
