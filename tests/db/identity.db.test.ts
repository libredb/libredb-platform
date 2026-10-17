import { randomUUID } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectAs, connectPlatform, connectSuperuser } from './connect'
import { expectSqlState } from './sqlstate'

const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'prisma', 'migrations')

function marker(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

async function insertUser(client: Client, user: { email: string; keycloakId?: string }): Promise<string> {
  const id = `identity_${marker()}`
  await client.query(
    `INSERT INTO platform.users (id, email, "keycloakId", "updatedAt") VALUES ($1, $2, $3, now())`,
    [id, user.email, user.keycloakId ?? null],
  )
  return id
}

function insertCredential(client: Client, credential: { userId: string; email: string }) {
  return client.query(
    `INSERT INTO platform.password_credentials ("userId", email, "passwordHash", "updatedAt") VALUES ($1, $2, $3, now())`,
    [credential.userId, credential.email, '$2b$12$identity.test.hash'],
  )
}

// Users are keyed by their Keycloak id, and cloud passwords live in password_credentials.
// The tables come from tests/db/global-setup.ts, which applies every migration as libredb_owner; these tests write as the runtime role.
describe('identity tables', () => {
  let platform: Client

  beforeAll(async () => {
    platform = await connectPlatform()
  })

  afterAll(async () => {
    await platform.end()
  })

  it('two users may share an email', async () => {
    const email = `shared-${marker()}@example.com`
    const first = await insertUser(platform, { email })
    const second = await insertUser(platform, { email, keycloakId: randomUUID() })

    const users = await platform.query<{ id: string }>('SELECT id FROM platform.users WHERE email = $1', [email])
    expect(users.rows.map((row) => row.id).sort()).toEqual([first, second].sort())
  })

  it('keycloakId is unique', async () => {
    const keycloakId = randomUUID()
    await insertUser(platform, { email: `first-${marker()}@example.com`, keycloakId })

    await expectSqlState(insertUser(platform, { email: `second-${marker()}@example.com`, keycloakId }), UNIQUE_VIOLATION)
  })

  it('keycloakId may be null for any number of cloud password users', async () => {
    await insertUser(platform, { email: `cloud-${marker()}@example.com` })
    await insertUser(platform, { email: `cloud-${marker()}@example.com` })

    const nulls = await platform.query<{ count: string }>('SELECT count(*) FROM platform.users WHERE "keycloakId" IS NULL')
    expect(Number(nulls.rows[0].count)).toBeGreaterThanOrEqual(2)
  })

  it('password_credentials refuses an email that is not lower case (23514)', async () => {
    const userId = await insertUser(platform, { email: `Mixed.${marker()}@Example.com` })

    await expectSqlState(insertCredential(platform, { userId, email: `Mixed.${marker()}@Example.com` }), CHECK_VIOLATION)
  })

  it('password_credentials holds one credential per email', async () => {
    const email = `taken-${marker()}@example.com`
    await insertCredential(platform, { userId: await insertUser(platform, { email }), email })

    await expectSqlState(insertCredential(platform, { userId: await insertUser(platform, { email }), email }), UNIQUE_VIOLATION)
  })

  it('deleting a user deletes its password credential', async () => {
    const email = `deleted-${marker()}@example.com`
    const userId = await insertUser(platform, { email })
    await insertCredential(platform, { userId, email })

    await platform.query('DELETE FROM platform.users WHERE id = $1', [userId])

    const left = await platform.query('SELECT 1 FROM platform.password_credentials WHERE "userId" = $1', [userId])
    expect(left.rows).toEqual([])
  })

  it('platform.users has no passwordHash column', async () => {
    const columns = await platform.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'users' AND column_name ILIKE '%password%'`,
    )
    expect(columns.rows).toEqual([])
  })
})

describe('identity migration', () => {
  // Every migration up to the identity migration, in the order prisma migrate deploy applies them.
  function migrationsThroughIdentity(): { before: string[]; identity: string } {
    const names = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const index = names.findIndex((name) => /^\d{14}_identity$/.test(name))
    expect(index, 'prisma/migrations holds a {timestamp}_identity migration').toBeGreaterThan(0)
    return { before: names.slice(0, index), identity: names[index] }
  }

  function migrationSql(name: string): string {
    return readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8')
  }

  it('moves existing password hashes to password_credentials under the lower-cased email before it drops users.passwordHash', async () => {
    const { before, identity } = migrationsThroughIdentity()
    const database = `identity_migration_${marker()}`
    const superuser = await connectSuperuser()
    try {
      await superuser.query(`CREATE DATABASE ${database} OWNER libredb_owner`)
      const owner = await connectAs('owner', database)
      try {
        for (const name of before) await owner.query(migrationSql(name))
        await owner.query(
          `INSERT INTO platform.users (id, email, "passwordHash", "updatedAt") VALUES
             ('user-alice', 'Alice@Example.com', '$2b$12$alice.hash', now()),
             ('user-bob', 'bob@example.com', NULL, now())`,
        )

        await owner.query(migrationSql(identity))

        const credentials = await owner.query(`SELECT "userId", email, "passwordHash" FROM platform.password_credentials`)
        expect(credentials.rows).toEqual([{ userId: 'user-alice', email: 'alice@example.com', passwordHash: '$2b$12$alice.hash' }])
        const users = await owner.query(`SELECT id, email, "keycloakId" FROM platform.users ORDER BY id`)
        expect(users.rows).toEqual([
          { id: 'user-alice', email: 'Alice@Example.com', keycloakId: null },
          { id: 'user-bob', email: 'bob@example.com', keycloakId: null },
        ])
      } finally {
        await owner.end()
      }
    } finally {
      await superuser.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      await superuser.end()
    }
  })
})
