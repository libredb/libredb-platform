// The preflight of the `migrate` subcommand (docs/deploy/platform-runtime.md): checks the database before
// `prisma migrate deploy` runs.
// It connects as the migrating role with a pg configuration derived from MIGRATE_DATABASE_URL, which is in Prisma syntax,
// and exits 1 naming the first check that failed. No message repeats a URL, because a URL carries a password.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export const CHECKS = {
  urlsSet: 'MIGRATE_DATABASE_URL and DATABASE_URL are set',
  urls: 'MIGRATE_DATABASE_URL and DATABASE_URL are PostgreSQL URLs',
  schema: 'both URLs carry schema=platform',
  tls: 'the TLS settings of MIGRATE_DATABASE_URL are supported',
  version: 'PostgreSQL 15 or newer',
  primary: 'the server is the primary, not a standby',
  owner: 'the migrating role owns the database',
  roles: 'the runtime roles libredb_platform and libredb_studio exist',
}

const MIN_SERVER_VERSION_NUM = 150000
const RUNTIME_ROLES = ['libredb_platform', 'libredb_studio']

export class PreflightError extends Error {
  /** @param {string} check one of CHECKS @param {string} detail */
  constructor(check, detail) {
    super(`preflight check failed: ${check}: ${detail}`)
    this.name = 'PreflightError'
    this.check = check
  }
}

/** @param {string} name @param {string} value */
function parsePostgresUrl(name, value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new PreflightError(CHECKS.urls, `${name} is not a URL`)
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new PreflightError(CHECKS.urls, `${name} must start with postgresql:// or postgres://`)
  }
  return url
}

/**
 * The pg client configuration of a Prisma-syntax PostgreSQL URL.
 * Prisma's TLS parameters map as follows: TLS is used with sslmode=require, or when sslcert or sslaccept is given;
 * sslcert, an absolute path to the CA certificate, becomes the CA; sslaccept=strict becomes verify-full (the chain and
 * the host name are checked), and accept_invalid_certs, Prisma's default, accepts any certificate.
 * sslmode=prefer, Prisma's default, connects without TLS, because pg cannot fall back from TLS to plain text.
 * @param {string} value
 * @param {(file: string) => string} [readFile]
 * @returns {import('pg').ClientConfig}
 */
export function pgConfigFromPrismaUrl(value, readFile = file => readFileSync(file, 'utf8')) {
  const url = parsePostgresUrl('MIGRATE_DATABASE_URL', value)
  const params = url.searchParams
  for (const unsupported of ['sslidentity', 'sslpassword']) {
    if (params.has(unsupported)) {
      throw new PreflightError(CHECKS.tls, `${unsupported} (a client certificate) is not supported by the preflight`)
    }
  }
  const sslmode = params.get('sslmode') ?? 'prefer'
  if (!['disable', 'prefer', 'require'].includes(sslmode)) {
    throw new PreflightError(CHECKS.tls, 'sslmode must be disable, prefer or require, the values Prisma accepts')
  }
  const sslaccept = params.get('sslaccept')
  if (sslaccept !== null && sslaccept !== 'strict' && sslaccept !== 'accept_invalid_certs') {
    throw new PreflightError(CHECKS.tls, 'sslaccept must be strict or accept_invalid_certs')
  }
  const sslcert = params.get('sslcert')

  let ssl = false
  if (sslmode !== 'disable' && (sslmode === 'require' || sslcert !== null || sslaccept !== null)) {
    ssl = { rejectUnauthorized: sslaccept === 'strict' }
    if (sslcert !== null) {
      if (!path.isAbsolute(sslcert)) {
        throw new PreflightError(CHECKS.tls, 'sslcert must be an absolute path to the CA certificate')
      }
      let ca
      try {
        ca = readFile(sslcert)
      } catch (error) {
        throw new PreflightError(CHECKS.tls, `sslcert ${sslcert} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
      }
      ssl = { ca, ...ssl }
    }
  }

  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  }
}

/** @param {number} num a server_version_num, such as 170004 */
function formatVersion(num) {
  return `${Math.floor(num / 10000)}.${num % 10000}`
}

/**
 * Runs every check against `env` and resolves when all pass; rejects with a PreflightError naming the first failure.
 * @param {Record<string, string | undefined>} env
 * @param {(config: import('pg').ClientConfig) => Promise<{ query(text: string): Promise<{ rows: any[] }>, end(): Promise<void> }>} connect
 */
export async function runPreflight(env, connect) {
  const missing = ['MIGRATE_DATABASE_URL', 'DATABASE_URL'].filter(name => !env[name])
  if (missing.length > 0) throw new PreflightError(CHECKS.urlsSet, `${missing.join(' and ')} not set`)

  const migrateUrl = parsePostgresUrl('MIGRATE_DATABASE_URL', env.MIGRATE_DATABASE_URL)
  const databaseUrl = parsePostgresUrl('DATABASE_URL', env.DATABASE_URL)
  for (const [name, url] of [['MIGRATE_DATABASE_URL', migrateUrl], ['DATABASE_URL', databaseUrl]]) {
    if (url.searchParams.get('schema') !== 'platform') {
      throw new PreflightError(CHECKS.schema, `${name} must carry schema=platform`)
    }
  }

  const client = await connect(pgConfigFromPrismaUrl(env.MIGRATE_DATABASE_URL))
  try {
    const [{ version }] = (await client.query('SELECT current_setting(\'server_version_num\')::int AS version')).rows
    if (Number(version) < MIN_SERVER_VERSION_NUM) {
      throw new PreflightError(CHECKS.version, `the server runs PostgreSQL ${formatVersion(Number(version))}`)
    }

    const [{ standby }] = (await client.query('SELECT pg_is_in_recovery() AS standby')).rows
    if (standby) throw new PreflightError(CHECKS.primary, 'the server is in recovery; migrate against the primary')

    const [{ owner, role }] = (await client.query(
      'SELECT pg_get_userbyid(datdba) AS owner, current_user AS role FROM pg_database WHERE datname = current_database()',
    )).rows
    if (owner !== role) throw new PreflightError(CHECKS.owner, `the database is owned by ${owner}, not by ${role}`)

    const { rows } = await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN (${RUNTIME_ROLES.map(name => `'${name}'`).join(', ')})`,
    )
    const present = new Set(rows.map(row => row.rolname))
    const absent = RUNTIME_ROLES.filter(name => !present.has(name))
    if (absent.length > 0) {
      throw new PreflightError(CHECKS.roles, `missing ${absent.join(', ')}; run the database bootstrap of docs/deploy/platform-runtime.md`)
    }
  } finally {
    await client.end()
  }
}

/** Opens a pg client with `config`. */
async function connectPg(config) {
  const client = new pg.Client(config)
  await client.connect()
  return client
}

async function main() {
  try {
    await runPreflight(process.env, connectPg)
    console.log('preflight: every check passed')
    return 0
  } catch (error) {
    if (error instanceof PreflightError) {
      console.error(error.message)
    } else {
      // A connection or query error: pg's messages name the host and the role, never the password.
      console.error(`preflight failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
