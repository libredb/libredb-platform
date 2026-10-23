import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectPlatform, connectStudio, connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { createFreshDatabase } from '../../../../tests/db/fresh-database'
import { expectSqlState } from '../../../../tests/db/sqlstate'
import { LicenseLimitError } from '@/shared/lib/errors'
import { licenseStatus, type LicensePayload, type LicenseStatus } from '@/shared/lib/license'
import { requireSeatsForNewConnection } from '@/shared/lib/license/seats'
import { sealSecret, type CredentialSet } from '@/shared/lib/sealing/lsb1'
import type { NewDatabaseConnection } from './database-connection.repository'
import type { GrantSetting } from './grant.repository'

// The user seats of an install are every subject that bridge.grants_v1 publishes, so this file reads a database of its
// own that no other test writes to, and each test starts without connections or grants.
const DATABASE = 'libredb_license_gates'
const TENANT = 'tenant-install'
const PLAN = 'plan-enterprise'
const ACTOR = 'user-admin'

const DAY_MS = 24 * 60 * 60 * 1000

// A license issued 2026-10-16 that expires 2027-10-16; each test sets its user seats.
const LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-2026.0042',
  customer: 'Example Customer',
  adminSeats: 2,
  userSeats: 25,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
}

// An instant in each state of LICENSE, which is expiring from 2027-09-16, in grace from 2027-10-16 and expired from
// 2027-10-30.
const AT = {
  active: new Date('2027-01-01T00:00:00Z'),
  expiring: new Date('2027-10-01T00:00:00Z'),
  grace: new Date('2027-10-20T00:00:00Z'),
  expired: new Date('2027-11-01T00:00:00Z'),
}

/** The status of LICENSE with this many user seats in a state of a valid license. */
function valid(state: keyof typeof AT, userSeats: number): LicenseStatus {
  const status = licenseStatus({ ok: true, license: { ...LICENSE, userSeats } }, AT[state])
  if (status.state !== state) throw new Error(`${AT[state].toISOString()} is not in state ${state}`)
  return status
}

// A token that fails verification, which grants no seat.
const INVALID = licenseStatus({ ok: false, code: 'LICENSE_HOST_MISMATCH' }, AT.active)

// A published test key of Studio's lsb1 vectors, which protects nothing.
const VECTORS_FILE = path.resolve(__dirname, '../../../../tests/fixtures/governance/lsb1-vectors.json')
const CANARY = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors.find(
  (vector: { id: string }) => vector.id === 'canary',
) as { recipientPublicKey: string }
const PUBLIC_KEY = Buffer.from(CANARY.recipientPublicKey, 'base64url')

const READ: CredentialSet = { user: 'orders_reader', password: 'read-pass-1' }
const WRITE: CredentialSet = { user: 'orders_writer', password: 'write-pass-1' }
const DEFINITION = { host: 'db.internal', port: 5432, database: 'orders' }

/** A new connection with a read and a write credential sealed for its id, as Platform creates one. */
function connectionInput(id: string): NewDatabaseConnection {
  const seal = (level: 'read' | 'write', plaintext: CredentialSet) =>
    sealSecret({ connectionId: id, level, engine: 'postgres', definition: DEFINITION, plaintext }, PUBLIC_KEY)
  return {
    id,
    name: 'Orders',
    engine: 'postgres',
    environment: null,
    groupName: null,
    color: null,
    mcpEnabled: false,
    definition: DEFINITION,
    readSecret: seal('read', READ),
    writeSecret: seal('write', WRITE),
  }
}

/** 'allowed', or the code of the LicenseLimitError that refuses the write. */
async function outcome(write: Promise<unknown>): Promise<string> {
  try {
    await write
    return 'allowed'
  } catch (error) {
    if (error instanceof LicenseLimitError) return error.code
    throw error
  }
}

describe('the license gates of grants and connections on PostgreSQL', () => {
  let grants: typeof import('./grant.repository').ConnectionGrantRepository
  let connections: typeof import('./database-connection.repository').DatabaseConnectionRepository
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client
  let studio: Client

  /** A connection of the install, created and paused without a license, as cloud mode writes. */
  async function newConnection({ active = true } = {}): Promise<string> {
    const id = randomUUID()
    await connections.create(TENANT, ACTOR, 'web', connectionInput(id), null)
    if (!active) await connections.update(TENANT, id, ACTOR, 'web', { active: false }, [], null)
    return id
  }

  /** Grants `subject` read access to the connection under the license, with no expiry unless overridden. */
  function grantTo(
    connectionId: string,
    subject: string,
    license: LicenseStatus | null = null,
    overrides: Partial<GrantSetting> = {},
  ) {
    const setting: GrantSetting = {
      connectionId,
      subject,
      subjectUsername: subject,
      subjectEmail: null,
      level: 'read',
      expiresAt: null,
      ...overrides,
    }
    return grants.set(TENANT, ACTOR, 'web', setting, new Date(), license)
  }

  function reactivate(connectionId: string, license: LicenseStatus | null) {
    return connections.update(TENANT, connectionId, ACTOR, 'web', { active: true }, [], license)
  }

  /** The subjects bridge.grants_v1 publishes, read as Studio reads them. */
  async function published(): Promise<string[]> {
    const { rows } = await studio.query('SELECT DISTINCT subject FROM bridge.grants_v1 ORDER BY subject')
    return rows.map((row) => row.subject)
  }

  async function adminActions(): Promise<number> {
    const { rows } = await superuser.query('SELECT count(*)::integer AS count FROM platform.admin_actions')
    return rows[0].count
  }

  /** Locks the install tenant row on its own connection until `commit` or `release`, as another gated write would. */
  async function holdTenantRow() {
    const holder = await connectPlatform(DATABASE)
    await holder.query('BEGIN')
    // FOR NO KEY UPDATE conflicts with the lock of a gate, and not with the key share that a foreign key check takes,
    // so only a write that locks the row itself waits for it.
    await holder.query('SELECT id FROM platform.tenants WHERE id = $1 FOR NO KEY UPDATE', [TENANT])
    let released = false
    /** Ends the holder's transaction with `statement` and closes its connection; a second call does nothing. */
    async function end(statement: 'COMMIT' | 'ROLLBACK'): Promise<void> {
      if (released) return
      released = true
      try {
        await holder.query(statement)
      } finally {
        await holder.end()
      }
    }
    return {
      /** Runs a statement in the holder's transaction, which keeps it uncommitted until `commit`. */
      async query(text: string, values: unknown[]): Promise<void> {
        await holder.query(text, values)
      },
      /**
       * Resolves once `count` backends of this database are blocked, which only the held row can do here: the first
       * write that waits for it waits for the holder, and each later one for the write ahead of it.
       */
      async waiters(count: number): Promise<void> {
        const deadline = Date.now() + 5_000
        for (;;) {
          const waiting = await superuser.query(
            `SELECT count(*)::integer AS count FROM pg_stat_activity
             WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
          )
          if (waiting.rows[0].count >= count) return
          if (Date.now() > deadline) throw new Error(`${count} writes did not wait for the install tenant row within 5 s`)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      },
      /** Commits the holder's transaction, which releases the row, and closes its connection. */
      commit: () => end('COMMIT'),
      /** Rolls the holder's transaction back and closes its connection, unless `commit` or an earlier call did. */
      release: () => end('ROLLBACK'),
    }
  }

  beforeAll(async () => {
    await createFreshDatabase(DATABASE)
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform', DATABASE)}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    ;({ ConnectionGrantRepository: grants } = await import('./grant.repository'))
    ;({ DatabaseConnectionRepository: connections } = await import('./database-connection.repository'))
    superuser = await connectSuperuser(DATABASE)
    studio = await connectStudio(DATABASE)

    await superuser.query(
      `INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, 'ENTERPRISE', 'Enterprise', now())`,
      [PLAN],
    )
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'Example Customer', 'default', $2, now())`,
      [TENANT, PLAN],
    )
    await superuser.query(
      `INSERT INTO platform.users (id, "keycloakId", email, "updatedAt") VALUES ($1, $2, 'admin@libredb.test', now())`,
      [ACTOR, randomUUID()],
    )
  })

  beforeEach(async () => {
    // The grants go with their connections, by the foreign key's cascade.
    await superuser.query('DELETE FROM platform.admin_actions')
    await superuser.query('DELETE FROM platform.database_connections')
  })

  afterAll(async () => {
    await superuser.end()
    await studio.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('refuses a grant to a subject without a user seat under an invalid license, at the limit and after expiry, and gives a seat holder another level, expiry or connection in every state', async () => {
    const orders = await newConnection()
    await grantTo(orders, 'alice')
    await grantTo(orders, 'bob', null, { expiresAt: new Date(Date.now() + DAY_MS) })
    await grantTo(orders, 'carol')
    const recorded = await adminActions()

    const statuses: Array<[string, LicenseStatus, string]> = [
      ['invalid', INVALID, 'LICENSE_INVALID'],
      ['active', valid('active', 3), 'LICENSE_USER_SEATS'],
      ['expiring', valid('expiring', 3), 'LICENSE_USER_SEATS'],
      ['grace', valid('grace', 3), 'LICENSE_USER_SEATS'],
      ['expired', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    for (const [index, [name, license, refusal]] of statuses.entries()) {
      // zoe holds no grant, so she would take a fourth seat.
      expect(await outcome(grantTo(orders, 'zoe', license)), name).toBe(refusal)
      // alice's level changes, bob's grant runs a day longer, and carol gets a connection she has no grant on.
      const level = index % 2 === 0 ? 'write' : 'read'
      expect(await outcome(grantTo(orders, 'alice', license, { level })), name).toBe('allowed')
      const expiresAt = new Date(Date.now() + (index + 2) * DAY_MS)
      expect(await outcome(grantTo(orders, 'bob', license, { expiresAt })), name).toBe('allowed')
      expect(await outcome(grantTo(await newConnection(), 'carol', license)), name).toBe('allowed')
    }

    expect(await published()).toEqual(['alice', 'bob', 'carol'])
    // Each state recorded its three allowed grants and the connection it created, and no refused grant.
    expect(await adminActions()).toBe(recorded + statuses.length * 4)

    // Below the limit a subject without a seat takes one, and at the limit the next one is refused.
    expect(await outcome(grantTo(orders, 'zoe', valid('active', 4)))).toBe('allowed')
    expect(await outcome(grantTo(orders, 'yann', valid('active', 4)))).toBe('LICENSE_USER_SEATS')
    expect(await published()).toEqual(['alice', 'bob', 'carol', 'zoe'])
  })

  it('allows a grant on a paused connection to a subject without a user seat, and a change of it, at the limit, under an invalid license and after expiry, refuses the same grant on an active connection, and counts it when the connection turns active again', async () => {
    const orders = await newConnection()
    for (const subject of ['alice', 'bob', 'carol']) await grantTo(orders, subject)
    const paused = await newConnection({ active: false })
    const recorded = await adminActions()

    const statuses: Array<[string, LicenseStatus, string]> = [
      ['invalid', INVALID, 'LICENSE_INVALID'],
      ['active at the limit', valid('active', 3), 'LICENSE_USER_SEATS'],
      ['expired', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    for (const [index, [name, license, refusal]] of statuses.entries()) {
      // zoe holds no seat, so a grant on the active connection would give her a fourth one now.
      expect(await outcome(grantTo(orders, 'zoe', license)), name).toBe(refusal)
      // On the paused connection her grant gives no access until the connection is active again, so neither the grant
      // nor a change of its level and expiry takes a seat.
      expect(await outcome(grantTo(paused, 'zoe', license)), name).toBe('allowed')
      const expiresAt = new Date(Date.now() + (index + 2) * DAY_MS)
      expect(await outcome(grantTo(paused, 'zoe', license, { level: 'write', expiresAt })), name).toBe('allowed')
    }
    expect(await published()).toEqual(['alice', 'bob', 'carol'])
    // Each state recorded zoe's grant on the paused connection and its change, and no refused grant.
    expect(await adminActions()).toBe(recorded + statuses.length * 2)

    // Active again, the connection would publish zoe as a fourth user seat.
    const refused: Array<[string, LicenseStatus, string]> = [
      ['invalid', INVALID, 'LICENSE_INVALID'],
      ['active at the limit', valid('active', 3), 'LICENSE_USER_SEATS'],
      ['expired', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    for (const [name, license, code] of refused) {
      expect(await outcome(reactivate(paused, license)), name).toBe(code)
    }
    expect(await published()).toEqual(['alice', 'bob', 'carol'])

    expect(await outcome(reactivate(paused, valid('active', 4)))).toBe('allowed')
    expect(await published()).toEqual(['alice', 'bob', 'carol', 'zoe'])
  })

  it('counts no seat for a grant that bridge.grants_v1 does not publish, so a subject whose only grant expired or is on a paused or deleted connection holds none', async () => {
    const orders = await newConnection()
    const reports = await newConnection()
    await grantTo(orders, 'alice')
    await grantTo(orders, 'bob')
    // erin's only grant expired yesterday, dave's is on a paused connection and frank's on a deleted one.
    await superuser.query(
      `INSERT INTO platform.connection_grants (id, "connectionId", subject, "subjectUsername", level, "expiresAt", "grantedById", "grantedAt")
       VALUES ($1, $2, 'erin', 'erin', 'read', now() - interval '1 day', $3, now() - interval '2 days')`,
      [randomUUID(), orders, ACTOR],
    )
    await grantTo(await newConnection({ active: false }), 'dave')
    const removed = await newConnection()
    await grantTo(removed, 'frank')
    // Platform deletes the grants of a connection it deletes, so the connection is marked deleted here directly, which
    // leaves frank's grant behind.
    await superuser.query(
      'UPDATE platform.database_connections SET active = false, "deletedAt" = now() WHERE id = $1',
      [removed],
    )
    expect(await published()).toEqual(['alice', 'bob'])

    // With both of 2 user seats in use, none of them may be granted another connection, as a seat holder may.
    const statuses: Array<[string, LicenseStatus, string]> = [
      ['active at the limit', valid('active', 2), 'LICENSE_USER_SEATS'],
      ['expired', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    for (const [name, license, refusal] of statuses) {
      for (const subject of ['erin', 'dave', 'frank']) {
        expect(await outcome(grantTo(reports, subject, license)), `${name}: ${subject}`).toBe(refusal)
      }
      expect(await outcome(grantTo(reports, 'alice', license)), name).toBe('allowed')
    }

    // Their grants count toward no limit: with 2 user seats in use, a license of 2 allows a new connection, and one of
    // 3 a grant to zoe, after which the next new subject is refused.
    expect(await outcome(connections.create(TENANT, ACTOR, 'web', connectionInput(randomUUID()), valid('active', 2)))).toBe(
      'allowed',
    )
    expect(await outcome(grantTo(orders, 'zoe', valid('active', 3)))).toBe('allowed')
    expect(await outcome(grantTo(orders, 'yann', valid('active', 3)))).toBe('LICENSE_USER_SEATS')
    expect(await published()).toEqual(['alice', 'bob', 'zoe'])
  })

  it('refuses a new connection under an invalid license, after expiry and when more user seats are in use than allowed, and allows one at the limit', async () => {
    const orders = await newConnection()
    for (const subject of ['alice', 'bob', 'carol']) await grantTo(orders, subject)
    const recorded = await adminActions()

    const statuses: Array<[string, LicenseStatus, string]> = [
      ['invalid', INVALID, 'LICENSE_INVALID'],
      ['active at the limit', valid('active', 3), 'allowed'],
      ['grace at the limit', valid('grace', 3), 'allowed'],
      ['active above the limit', valid('active', 2), 'LICENSE_USER_SEATS'],
      ['expiring above the limit', valid('expiring', 2), 'LICENSE_USER_SEATS'],
      ['expired', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    const created: string[] = []
    for (const [name, license, expected] of statuses) {
      const id = randomUUID()
      expect(await outcome(connections.create(TENANT, ACTOR, 'web', connectionInput(id), license)), name).toBe(expected)
      if (expected === 'allowed') created.push(id)
    }

    const { rows } = await superuser.query('SELECT id FROM platform.database_connections WHERE id <> $1', [orders])
    expect(rows.map((row) => row.id).sort()).toEqual([...created].sort())
    expect(await adminActions()).toBe(recorded + created.length)
  })

  it('refuses turning a connection active again when the subjects of its unexpired grants bring the user seats above the limit, under an invalid license and after expiry', async () => {
    const orders = await newConnection()
    await grantTo(orders, 'alice')
    await grantTo(orders, 'bob')
    const paused = await newConnection()
    for (const subject of ['bob', 'carol', 'dave']) await grantTo(paused, subject)
    await connections.update(TENANT, paused, ACTOR, 'web', { active: false }, [], null)
    // erin's grant on the paused connection has expired, so it publishes nothing once the connection is active again.
    await superuser.query(
      `INSERT INTO platform.connection_grants (id, "connectionId", subject, "subjectUsername", level, "expiresAt", "grantedById", "grantedAt")
       VALUES ($1, $2, 'erin', 'erin', 'read', now() - interval '1 day', $3, now() - interval '2 days')`,
      [randomUUID(), paused, ACTOR],
    )
    expect(await published()).toEqual(['alice', 'bob'])
    const recorded = await adminActions()

    // Active again, the connection would publish carol and dave as well: 4 user seats.
    const refused: Array<[string, LicenseStatus, string]> = [
      ['active with 3 seats', valid('active', 3), 'LICENSE_USER_SEATS'],
      ['invalid', INVALID, 'LICENSE_INVALID'],
      ['expired', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    for (const [name, license, code] of refused) {
      expect(await outcome(reactivate(paused, license)), name).toBe(code)
    }
    expect(await published()).toEqual(['alice', 'bob'])
    expect(await adminActions()).toBe(recorded)

    expect(await outcome(reactivate(paused, valid('active', 4)))).toBe('allowed')
    expect(await published()).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('makes each gated write wait for the row lock of the install tenant, and no write in cloud mode', async () => {
    const orders = await newConnection()
    const paused = await newConnection({ active: false })
    const writes: Array<[string, (license: LicenseStatus | null) => Promise<unknown>]> = [
      ['a grant', (license) => grantTo(orders, `subject-${randomUUID()}`, license)],
      ['a new connection', (license) => connections.create(TENANT, ACTOR, 'web', connectionInput(randomUUID()), license)],
      [
        'a reactivation',
        async (license) => {
          await connections.update(TENANT, paused, ACTOR, 'web', { active: false }, [], null)
          return reactivate(paused, license)
        },
      ],
    ]

    for (const [write, run] of writes) {
      const lock = await holdTenantRow()
      try {
        // Without a license status no write takes the lock, so each one ends while the row is held.
        await run(null)

        let settled = false
        const gated = run(valid('active', 100)).finally(() => {
          settled = true
        })
        await lock.waiters(1)
        expect(settled, write).toBe(false)
        await lock.release()
        await gated
      } finally {
        await lock.release()
      }
    }
  })

  it('holds the row of the install tenant FOR NO KEY UPDATE in a gate, which another gate waits for and an insert that references the tenant does not', async () => {
    // The gate of a new connection runs in a transaction that holds its lock until `release` is called.
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked!: () => void
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve
    })
    const gate = db.$transaction(async (tx) => {
      await requireSeatsForNewConnection(tx, valid('active', 100), TENANT)
      locked()
      await released
    })
    const other = await connectPlatform(DATABASE)
    const notification = randomUUID()
    try {
      await Promise.race([lockTaken, gate])
      // Another gated write would wait for the lock, so asking for it without waiting fails at once.
      await expectSqlState(
        other.query('SELECT id FROM platform.tenants WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [TENANT]),
        '55P03',
      )
      // The foreign key check of this insert takes a key share lock on the tenant row, which the gate's lock does not
      // conflict with; a wait for it would fail the insert with lock_not_available after the lock timeout.
      await other.query(`SET lock_timeout = '1s'`)
      await other.query(
        `INSERT INTO platform.notifications (id, "tenantId", "userId", type, title, message)
         VALUES ($1, $2, $3, 'info', 'Seat gate', 'Written while a gate holds the install tenant row')`,
        [notification, TENANT, ACTOR],
      )
    } finally {
      release()
      await gate
      await other.end()
    }
    const { rows } = await superuser.query('SELECT "tenantId" FROM platform.notifications WHERE id = $1', [
      notification,
    ])
    expect(rows).toEqual([{ tenantId: TENANT }])
  })

  it('grants exactly one of two subjects without a seat who ask for the last seat at the same time', async () => {
    const orders = await newConnection()
    await grantTo(orders, 'alice')
    await grantTo(orders, 'bob')
    const oneSeatLeft = valid('active', 3)

    // Both grants wait for the held row, so neither counts the seats before the other one could have committed.
    const lock = await holdTenantRow()
    const race = Promise.allSettled([grantTo(orders, 'carol', oneSeatLeft), grantTo(orders, 'dave', oneSeatLeft)])
    try {
      await lock.waiters(2)
    } finally {
      await lock.release()
    }
    const results = await race

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toBeInstanceOf(LicenseLimitError)
    expect(refused.reason.code).toBe('LICENSE_USER_SEATS')
    const seats = await published()
    expect(seats).toHaveLength(3)
    expect(seats.slice(0, 2)).toEqual(['alice', 'bob'])
  })

  it('refuses a grant on a paused connection to a subject without a user seat at the limit when a reactivation of that connection commits while the grant waits for the install tenant row', async () => {
    const orders = await newConnection()
    for (const subject of ['alice', 'bob', 'carol']) await grantTo(orders, subject)
    const paused = await newConnection({ active: false })

    // Another transaction holds the row, as the gate of a reactivation does, and turns the connection active without
    // committing yet.
    const lock = await holdTenantRow()
    let refusal: Promise<string> | undefined
    try {
      await lock.query('UPDATE platform.database_connections SET active = true WHERE id = $1', [paused])
      // zoe holds no seat and the license's 3 user seats are in use, so her grant would take a fourth one once the
      // connection is active; it waits for the row before it reads the connection.
      let settled = false
      refusal = outcome(grantTo(paused, 'zoe', valid('active', 3))).finally(() => {
        settled = true
      })
      await lock.waiters(1)
      expect(settled).toBe(false)
      await lock.commit()
    } finally {
      await lock.release()
    }
    expect(await refusal).toBe('LICENSE_USER_SEATS')

    const { rows } = await superuser.query('SELECT active FROM platform.database_connections WHERE id = $1', [paused])
    expect(rows).toEqual([{ active: true }])
    const zoe = await superuser.query('SELECT id FROM platform.connection_grants WHERE subject = $1', ['zoe'])
    expect(zoe.rows).toEqual([])
    expect(await published()).toEqual(['alice', 'bob', 'carol'])
  })

  it('keeps every existing grant in bridge.grants_v1 under an invalid license and after expiry, and deactivates no connection and revokes no grant', async () => {
    const orders = await newConnection()
    const reports = await newConnection()
    const paused = await newConnection()
    await grantTo(orders, 'alice', null, { level: 'write' })
    await grantTo(orders, 'bob')
    await grantTo(reports, 'carol', null, { expiresAt: new Date(Date.now() + DAY_MS) })
    await grantTo(paused, 'dave')
    await connections.update(TENANT, paused, ACTOR, 'web', { active: false }, [], null)
    const snapshot = async () => ({
      published: (await studio.query('SELECT * FROM bridge.grants_v1 ORDER BY subject, connection_id')).rows,
      grants: (await superuser.query('SELECT * FROM platform.connection_grants ORDER BY id')).rows,
      connections: (await superuser.query('SELECT id, active, "deletedAt" FROM platform.database_connections ORDER BY id')).rows,
    })
    const before = await snapshot()
    expect(before.published.map((row) => row.subject)).toEqual(['alice', 'bob', 'carol'])

    const expired = valid('expired', 100)
    for (const [license, code] of [
      [INVALID, 'LICENSE_INVALID'],
      [expired, 'LICENSE_EXPIRED'],
    ] as const) {
      expect(await outcome(grantTo(orders, 'zoe', license)), code).toBe(code)
      expect(await outcome(connections.create(TENANT, ACTOR, 'web', connectionInput(randomUUID()), license)), code).toBe(code)
      expect(await outcome(reactivate(paused, license)), code).toBe(code)
    }

    expect(await snapshot()).toEqual(before)

    // The writes that add no seat still change what they change, and leave every other grant published.
    expect(await outcome(grantTo(orders, 'bob', INVALID, { level: 'write' }))).toBe('allowed')
    expect(await outcome(grantTo(reports, 'alice', expired))).toBe('allowed')
    const after = await snapshot()
    const pair = (row: { subject: string; connection_id: string }) => `${row.subject} on ${row.connection_id}`
    expect(after.published.map(pair).sort()).toEqual([...before.published.map(pair), `alice on ${reports}`].sort())
    expect(after.connections).toEqual(before.connections)
    expect(after.grants.map((row) => row.id)).toEqual(expect.arrayContaining(before.grants.map((row) => row.id)))
  })
})
