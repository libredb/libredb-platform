// Development only: drops Platform's schemas and rebuilds them from prisma/migrations and the seed.
// Run it as `ALLOW_DB_RESET=1 npm run db:reset`.
//
// It connects as libredb_owner through MIGRATE_DATABASE_URL and drops the schemas bridge and platform,
// which libredb_owner owns; schema platform holds the Prisma migration history, so the
// history goes with it. It never touches schema studio, which belongs to libredb_studio.
// Then it runs `prisma migrate deploy` and `prisma db seed`.
//
// ALLOW_DB_RESET is read from the shell environment only, never from .env files, so the confirmation
// cannot be left switched on by accident. The other variables come from the environment, then .env.local,
// then .env, the order prisma.config.ts uses.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import pg from 'pg'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Bridge first: its views read platform tables.
const SCHEMAS = ['bridge', 'platform']

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ query(sql: string): Promise<unknown>, end(): Promise<void> }} ResetClient
 * @param {{
 *   env: Env,
 *   connect: (url: string) => Promise<ResetClient>,
 *   run: (command: string, args: string[], env: Env) => Promise<void>,
 * }} deps
 */
export async function resetDatabase({ env, connect, run }) {
  if (env.ALLOW_DB_RESET !== '1') {
    throw new Error(
      'db:reset drops the schemas bridge and platform with all their data and is for development only. ' +
        'Run it as `ALLOW_DB_RESET=1 npm run db:reset`.',
    )
  }
  if (!env.MIGRATE_DATABASE_URL) {
    throw new Error('db:reset needs MIGRATE_DATABASE_URL, the libredb_owner URL with schema=platform (see .env.example).')
  }

  const client = await connect(env.MIGRATE_DATABASE_URL)
  try {
    for (const schema of SCHEMAS) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
  } finally {
    await client.end()
  }

  await run('prisma', ['migrate', 'deploy'], env)
  await run('prisma', ['db', 'seed'], env)
}

/** @param {string} file */
function readEnvFile(file) {
  const fullPath = path.join(ROOT, file)
  return existsSync(fullPath) ? parseEnv(readFileSync(fullPath, 'utf8')) : {}
}

/** @param {string} url */
async function connect(url) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  return client
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {Env} env
 */
function run(command, args, env) {
  const bin = path.join(ROOT, 'node_modules', '.bin', command)
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve(undefined)
      else reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit code ${code}`}`))
    })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = {
    ...readEnvFile('.env'),
    ...readEnvFile('.env.local'),
    ...process.env,
    ALLOW_DB_RESET: process.env.ALLOW_DB_RESET,
  }
  resetDatabase({ env, connect, run }).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
