import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { createFreshDatabase } from '../../../../tests/db/fresh-database'

// The user seats are every subject that bridge.grants_v1 publishes, so this file reads a database of its own that no
// other test writes to.
const DATABASE = 'libredb_user_seats'
const TENANT = 'tenant-install'
const PLAN = 'plan-enterprise'
const ACTOR = 'user-admin'

const DAY_MS = 24 * 60 * 60 * 1000

// Keycloak user ids, as grants name them.
const ALICE = '00000000-0000-4000-8000-00000000a11c'
const BOB = '00000000-0000-4000-8000-000000000b0b'
const CAROL = '00000000-0000-4000-8000-00000000ca20'
const DAVE = '00000000-0000-4000-8000-00000000da7e'
const ERIN = '00000000-0000-4000-8000-0000000000e2'
const FRANK = '00000000-0000-4000-8000-00000000f4a2'

describe('the user seats on PostgreSQL', () => {
  let userSeats: typeof import('./user-seats')
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client

  async function connection(id: string, { active = true, deleted = false } = {}): Promise<void> {
    // Only the lsb1 form that the table's CHECK requires: nothing here opens an envelope.
    await superuser.query(
      `INSERT INTO platform.database_connections
         (id, "tenantId", name, engine, definition, "readSecret", active, "deletedAt", "createdById", "updatedAt")
       VALUES ($1, $2, $1, 'postgres', '{"host":"db.internal","port":5432,"database":"orders"}',
               'lsb1.0123456789abcdef.envelope', $3, $4, $5, now())`,
      [id, TENANT, active, deleted ? new Date() : null, ACTOR],
    )
  }

  async function grant(
    connectionId: string,
    subject: string,
    username: string,
    { email = `${username}@libredb.test` as string | null, grantedAgoMs = DAY_MS, expiresInMs = null as number | null } = {},
  ): Promise<void> {
    const now = Date.now()
    await superuser.query(
      `INSERT INTO platform.connection_grants
         (id, "connectionId", subject, "subjectUsername", "subjectEmail", level, "expiresAt", "grantedById", "grantedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'read', $5, $6, $7, now())`,
      [
        connectionId,
        subject,
        username,
        email,
        expiresInMs === null ? null : new Date(now + expiresInMs),
        ACTOR,
        new Date(now - grantedAgoMs),
      ],
    )
  }

  beforeAll(async () => {
    await createFreshDatabase(DATABASE)
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform', DATABASE)}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    userSeats = await import('./user-seats')
    superuser = await connectSuperuser(DATABASE)

    await superuser.query(
      `INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, 'ENTERPRISE', 'Enterprise', now())`,
      [PLAN],
    )
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'Example Customer', 'default', $2, now())`,
      [TENANT, PLAN],
    )
    await superuser.query(
      `INSERT INTO platform.users (id, "keycloakId", email, "updatedAt") VALUES ($1, gen_random_uuid()::text, 'admin@libredb.test', now())`,
      [ACTOR],
    )

    await connection('orders')
    await connection('billing')
    await connection('paused', { active: false })
    await connection('removed', { deleted: true })

    // alice holds two published grants, and her latest one carries her current username and email.
    await grant('orders', ALICE, 'alice.old', { email: 'alice.old@libredb.test', grantedAgoMs: 3 * DAY_MS })
    await grant('billing', ALICE, 'alice')
    // bob's grant expires tomorrow, so it is published until then.
    await grant('orders', BOB, 'bob', { expiresInMs: DAY_MS })
    // carol's only grant expired yesterday, dave's is on a paused connection and erin's on a deleted one.
    await grant('orders', CAROL, 'carol', { grantedAgoMs: 2 * DAY_MS, expiresInMs: -DAY_MS })
    await grant('paused', DAVE, 'dave')
    await grant('removed', ERIN, 'erin')
    // frank has no email in the directory.
    await grant('orders', FRANK, 'frank', { email: null })
  })

  afterAll(async () => {
    await superuser.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('counts each subject that bridge.grants_v1 publishes once', async () => {
    expect(await userSeats.countUserSeatsInUse(db)).toBe(3)
  })

  it('lists the holders by username with the username and email of their latest grant and their connections', async () => {
    const holders = [
      { subject: ALICE, username: 'alice', email: 'alice@libredb.test', connections: 2 },
      { subject: BOB, username: 'bob', email: 'bob@libredb.test', connections: 1 },
      { subject: FRANK, username: 'frank', email: null, connections: 1 },
    ]

    expect(await userSeats.listUserSeatHolders(db, { first: 0, max: 20 })).toEqual(holders)
    expect(await userSeats.listUserSeatHolders(db, { first: 1, max: 1 })).toEqual([holders[1]])
    expect(await userSeats.listUserSeatHolders(db, { first: 3, max: 20 })).toEqual([])
  })

  it('tells which of some subjects hold a user seat', async () => {
    expect(await userSeats.userSeatHoldersAmong(db, [ALICE, CAROL, DAVE, ERIN, FRANK, 'unknown-subject'])).toEqual(
      new Set([ALICE, FRANK]),
    )
    expect(await userSeats.userSeatHoldersAmong(db, [])).toEqual(new Set())
  })

  it('counts the user seats that would be in use with a connection active', async () => {
    // Active, the paused connection would publish dave next to alice, bob and frank.
    expect(await userSeats.countUserSeatsWithConnectionActive(db, 'paused')).toBe(4)
    // orders is active already and adds nobody, since carol's grant on it expired.
    expect(await userSeats.countUserSeatsWithConnectionActive(db, 'orders')).toBe(3)
    expect(await userSeats.countUserSeatsWithConnectionActive(db, 'unknown-connection')).toBe(3)
  })
})
