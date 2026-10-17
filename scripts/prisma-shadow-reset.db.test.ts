import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { afterAll, describe, expect, it } from 'vitest'
import { connectOwner, connectSuperuser, fixtureUrl } from '../tests/db/connect'
import { resetShadowDatabase } from './prisma-shadow-reset'

const ROOT = path.resolve(__dirname, '..')
// The shadow database the bootstrap creates for development (docker/postgres/init/01-bootstrap.sh).
const SHADOW_DATABASE = 'libredb_shadow'
const SHADOW_DATABASE_URL = fixtureUrl('owner', SHADOW_DATABASE)

async function schemasOf(database: string): Promise<string[]> {
  const client = await connectSuperuser(database)
  try {
    const { rows } = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_catalog.pg_namespace
       WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%'
       ORDER BY nspname`,
    )
    return rows.map((row) => row.nspname)
  } finally {
    await client.end()
  }
}

// The drift check of the CI db-tests job, with the shadow database of the fixture server.
async function driftCheck(): Promise<void> {
  await promisify(execFile)('npm', ['run', '--silent', 'db:drift'], {
    cwd: ROOT,
    env: { ...process.env, SHADOW_DATABASE_URL, CHECKPOINT_DISABLE: '1' },
  })
}

describe('prisma-shadow-reset', () => {
  afterAll(async () => {
    await resetShadowDatabase(SHADOW_DATABASE_URL)
  })

  it('after a reset the shadow database holds no schema other than public', async () => {
    // What a replay of the migrations leaves behind: schema platform, and schema bridge with a function, which Prisma never resets.
    const owner = await connectOwner(SHADOW_DATABASE)
    try {
      await owner.query('CREATE SCHEMA IF NOT EXISTS platform')
      await owner.query('CREATE SCHEMA IF NOT EXISTS bridge')
      await owner.query('CREATE OR REPLACE FUNCTION bridge.leftover() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$')
    } finally {
      await owner.end()
    }
    expect(await schemasOf(SHADOW_DATABASE)).toEqual(expect.arrayContaining(['bridge', 'platform', 'public']))

    await resetShadowDatabase(SHADOW_DATABASE_URL)

    expect(await schemasOf(SHADOW_DATABASE)).toEqual(['public'])
  })

  it('refuses a database that holds a Prisma migration history', async () => {
    // Database libredb is migrated by the global setup, so it is a real database and never a shadow database.
    await expect(resetShadowDatabase(fixtureUrl('owner'))).rejects.toThrow('_prisma_migrations')
    expect(await schemasOf('libredb')).toEqual(expect.arrayContaining(['bridge', 'platform', 'studio']))
  })

  it('two drift checks in a row against the same shadow database both report no difference', { timeout: 180_000 }, async () => {
    await driftCheck()
    await driftCheck()
  })
})
