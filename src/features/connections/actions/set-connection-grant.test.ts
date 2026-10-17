import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Prisma } from '@prisma/client'
import type { DirectoryUser } from '@/shared/lib/keycloak/directory'
import { KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'

type Row = Record<string, unknown>
type Where = Record<string, unknown>
type GrantKey = { connectionId_subjectKind_subject: Where }

const caller = vi.hoisted(() => ({
  id: 'user-alice',
  email: 'alice@libredb.test',
  name: 'Alice',
  authProvider: 'keycloak',
  currentTenantId: 'tenant-1',
  membershipId: null,
  roles: ['TENANT_ADMIN'],
  permissions: ['connection.view', 'connection.create', 'connection.edit', 'connection.delete'] as string[],
  accessibleTenants: [],
  directoryDegraded: false,
}))

// An in-memory stand-in for the tables the action touches. `tx` is the client inside the one $transaction, which
// restores the tables when its callback throws, as a rolled back transaction would; `db` is the client outside it.
// connectionGrant.upsert keys a grant by (connectionId, subjectKind, subject) and applies the CHECK
// connection_grants_expiry_after_grant of the migration, so a write the database refuses fails here too.
// $queryRaw answers the statements of the seat gates over the same tables (tests/license/seat-statements.ts).
const { db, tx, tables } = vi.hoisted(() => {
  const tables: { tenant: Row[]; databaseConnection: Row[]; connectionGrant: Row[]; adminAction: Row[]; user: Row[] } = {
    tenant: [],
    databaseConnection: [],
    connectionGrant: [],
    adminAction: [],
    user: [],
  }
  const matches = (row: Row, where: Where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const client = () => ({
    $queryRaw: vi.fn(),
    databaseConnection: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const row = tables.databaseConnection.find((candidate) => matches(candidate, where))
        return row ? { ...row } : null
      }),
    },
    connectionGrant: {
      findUnique: vi.fn(async ({ where }: { where: GrantKey }) => {
        const row = tables.connectionGrant.find((candidate) =>
          matches(candidate, where.connectionId_subjectKind_subject))
        return row ? { ...row } : null
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: GrantKey; create: Row; update: Row }) => {
        const index = tables.connectionGrant.findIndex((candidate) =>
          matches(candidate, where.connectionId_subjectKind_subject))
        const next: Row =
          index < 0
            ? {
                id: `grant-${tables.connectionGrant.length + 1}`,
                subjectKind: 'user',
                grantedAt: new Date(),
                ...create,
                updatedAt: new Date(),
              }
            : { ...tables.connectionGrant[index], ...update, updatedAt: new Date() }
        const expiresAt = next.expiresAt as Date | null
        if (expiresAt !== null && expiresAt.getTime() <= (next.grantedAt as Date).getTime()) {
          throw new Error('violates check constraint "connection_grants_expiry_after_grant"')
        }
        if (index < 0) tables.connectionGrant.push(next)
        else tables.connectionGrant[index] = next
        return { ...next }
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = tables.user.find((candidate) => candidate.id === where.id)
        return row ? { ...row } : null
      }),
    },
    adminAction: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        tables.adminAction.push(data)
        return { id: `action-${tables.adminAction.length}`, ...data }
      }),
    },
  })
  const tx = client()
  const db = {
    ...client(),
    $transaction: vi.fn(async (run: (client: unknown) => Promise<unknown>): Promise<unknown> => {
      const saved = {
        databaseConnection: tables.databaseConnection.map((row) => ({ ...row })),
        connectionGrant: tables.connectionGrant.map((row) => ({ ...row })),
        adminAction: [...tables.adminAction],
        user: tables.user.map((row) => ({ ...row })),
      }
      try {
        return await run(tx)
      } catch (error) {
        Object.assign(tables, saved)
        throw error
      }
    }),
  }
  return { db, tx, tables }
})

vi.mock('@/shared/lib/db', () => ({ db }))

const requirePermission = vi.hoisted(() =>
  vi.fn(async (user: { permissions: string[] }, permission: string) => {
    if (!user.permissions.includes(permission)) {
      const { ForbiddenError } = await import('@/shared/lib/errors')
      throw new ForbiddenError(permission)
    }
  }),
)

vi.mock('@/shared/lib/auth-utils', () => ({
  getCurrentUser: vi.fn(async () => caller),
  requirePermission,
}))

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const revalidatePath = vi.hoisted(() => vi.fn())
vi.mock('next/cache', () => ({ revalidatePath }))

// The Keycloak directory as the Admin API reports it: getUser answers null for an id Keycloak does not know.
const directory = vi.hoisted(() => {
  const users = new Map<string, DirectoryUser>()
  return { users, getUser: vi.fn(async (id: string) => users.get(id) ?? null) }
})
vi.mock('@/shared/lib/keycloak/directory', () => ({ getKeycloakDirectory: () => directory }))

// The license status of the install, which each test sets: null in cloud mode, where licensing does not apply.
const license = vi.hoisted(() => ({ status: null as LicenseStatus | null }))
vi.mock('@/shared/lib/license/install-license', () => ({ getLicenseStatus: () => license.status }))

import { setConnectionGrant } from './set-connection-grant'
import { answerSeatStatement, locksTenant, statementText } from '../../../../tests/license/seat-statements'
import { LicenseLimitError } from '@/shared/lib/errors'
import { licenseStatus, type LicensePayload, type LicenseStatus } from '@/shared/lib/license'

const NOW = new Date('2026-10-15T08:00:00.000Z')
const LATER = new Date('2026-10-15T09:30:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

// Keycloak user ids of the fixture realm, tests/fixtures/keycloak/libredb-test-realm.json.
const ALICE = '00000000-0000-4000-8000-00000000a11c'
const GRACE = '00000000-0000-4000-8000-000000009ace'
const BOB = '00000000-0000-4000-8000-000000000b0b'
const DAVE = '00000000-0000-4000-8000-00000000da7e'
const FRANK = '00000000-0000-4000-8000-00000000f4a2'
const UNKNOWN = '00000000-0000-4000-8000-000000000000'

const KID = '0123456789abcdef'
const READ_SECRET = `lsb1.${KID}.${'A'.repeat(43)}.${'B'.repeat(30)}`
const WRITE_SECRET = `lsb1.${KID}.${'C'.repeat(43)}.${'D'.repeat(30)}`

type SetInput = Parameters<typeof setConnectionGrant>[0]

function grant(fields: Partial<SetInput> = {}) {
  return setConnectionGrant({ connectionId: 'conn-orders', subject: BOB, level: 'read', expiresAt: null, ...fields })
}

function connection(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenantId: 'tenant-1',
    name: 'Orders',
    engine: 'postgres',
    environment: 'production',
    groupName: null,
    color: null,
    definition: { host: 'db.internal', port: 5432, database: 'orders' },
    readSecret: READ_SECRET,
    writeSecret: WRITE_SECRET,
    mcpEnabled: false,
    active: true,
    deletedAt: null,
    createdById: 'user-alice',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  }
}

function directoryUser(id: string, username: string, overrides: Partial<DirectoryUser> = {}): DirectoryUser {
  const email = `${username}@libredb.test`
  return { id, username, email, firstName: null, lastName: null, enabled: true, ...overrides }
}

// A license issued 2026-10-16 that expires 2027-10-16, and the statuses of the install with it.
const LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-2026.0042',
  customer: 'Example Customer',
  adminSeats: 2,
  userSeats: 25,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
}
const FREE = licenseStatus(null, NOW)
const EXPIRED = licenseStatus({ ok: true, license: { ...LICENSE, userSeats: 100 } }, new Date('2027-11-01T00:00:00Z'))

const USER_SEATS_REFUSAL = { success: false, error: new LicenseLimitError('LICENSE_USER_SEATS').message }
const EXPIRED_REFUSAL = { success: false, error: new LicenseLimitError('LICENSE_EXPIRED').message }

/** An unexpired read grant in the tables, as the action writes one. */
function storedGrant(connectionId: string, subject: string, username: string, overrides: Row = {}): Row {
  return {
    id: `grant-${username}-${connectionId}`,
    connectionId,
    subjectKind: 'user',
    subject,
    subjectUsername: username,
    subjectEmail: `${username}@libredb.test`,
    level: 'read',
    expiresAt: null,
    grantedById: 'user-alice',
    grantedAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  caller.id = 'user-alice'
  caller.permissions = ['connection.view', 'connection.create', 'connection.edit', 'connection.delete']
  caller.directoryDegraded = false
  // A self-hosted install without a license runs on the free tier.
  license.status = FREE
  tables.tenant = [{ id: 'tenant-1' }, { id: 'tenant-2' }]
  tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
    answerSeatStatement(tables, strings, values),
  )
  tables.databaseConnection = [
    connection('conn-orders'),
    connection('conn-reports', { name: 'Reports', writeSecret: null }),
    connection('conn-gone', { active: false, deletedAt: new Date('2026-10-02T00:00:00Z') }),
    connection('conn-foreign', { tenantId: 'tenant-2', name: 'Billing' }),
  ]
  tables.connectionGrant = []
  tables.adminAction = []
  // The Platform users of the two admins, keyed by their Keycloak ids as the sign-in provisions them.
  tables.user = [
    { id: 'user-alice', keycloakId: ALICE, email: 'alice@libredb.test' },
    { id: 'user-grace', keycloakId: GRACE, email: 'grace@libredb.test' },
  ]
  directory.users.clear()
  for (const user of [
    directoryUser(ALICE, 'alice'),
    directoryUser(GRACE, 'grace'),
    directoryUser(BOB, 'bob'),
    directoryUser(DAVE, 'dave', { email: null }),
    directoryUser(FRANK, 'frank', { enabled: false }),
  ]) {
    directory.users.set(user.id, user)
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('setConnectionGrant', () => {
  it('write is refused when the connection has no write credential', async () => {
    const result = await grant({ connectionId: 'conn-reports', level: 'write' })

    expect(result).toEqual({
      success: false,
      error: 'Validation failed',
      fieldErrors: { level: ['The connection has no write credential, so it can be granted read only'] },
    })
    expect(tables.connectionGrant).toEqual([])
    expect(tables.adminAction).toEqual([])

    // Read stays open on that connection, and write on one with a write credential.
    expect((await grant({ connectionId: 'conn-reports', level: 'read' })).success).toBe(true)
    expect((await grant({ connectionId: 'conn-orders', level: 'write' })).success).toBe(true)
    expect(tables.connectionGrant.map((row) => [row.connectionId, row.level])).toEqual([
      ['conn-reports', 'read'],
      ['conn-orders', 'write'],
    ])
  })

  it('an unknown or disabled subject is refused', async () => {
    for (const [subject, message] of [
      [UNKNOWN, 'Keycloak has no user with this id'],
      [FRANK, 'frank is disabled in Keycloak'],
    ]) {
      const result = await grant({ subject })

      expect(result, subject).toEqual({
        success: false,
        error: 'Validation failed',
        fieldErrors: { subject: [message] },
      })
    }
    expect(directory.getUser.mock.calls).toEqual([[UNKNOWN], [FRANK]])
    expect(tables.connectionGrant).toEqual([])
    expect(tables.adminAction).toEqual([])
  })

  it('an expiry in the past is refused', async () => {
    for (const expiresAt of [new Date(NOW.getTime() - 60_000), NOW]) {
      const result = await grant({ expiresAt })

      expect(result, expiresAt.toISOString()).toEqual({
        success: false,
        error: 'Validation failed',
        fieldErrors: { expiresAt: ['must be in the future'] },
      })
    }
    expect(tables.connectionGrant).toEqual([])
    expect(tables.adminAction).toEqual([])

    // An expiry a millisecond ahead is kept, and the grant time is the time the action checked it against.
    const expiresAt = new Date(NOW.getTime() + 1)
    expect((await grant({ expiresAt })).success).toBe(true)
    expect(tables.connectionGrant).toEqual([expect.objectContaining({ expiresAt, grantedAt: NOW })])
  })

  it('a connection of another tenant or a deleted one answers NotFound', async () => {
    for (const connectionId of ['conn-foreign', 'conn-gone', 'conn-unknown']) {
      const result = await grant({ connectionId })

      expect(result, connectionId).toEqual({ success: false, error: 'Connection not found' })
    }
    expect(directory.getUser).not.toHaveBeenCalled()
    expect(tables.connectionGrant).toEqual([])
    expect(tables.adminAction).toEqual([])
  })

  it('snapshots username and email and records grantedById', async () => {
    const result = await grant()

    expect(result).toEqual({ success: true, data: { id: 'grant-1' } })
    expect(tables.connectionGrant).toEqual([
      {
        id: 'grant-1',
        connectionId: 'conn-orders',
        subjectKind: 'user',
        subject: BOB,
        subjectUsername: 'bob',
        subjectEmail: 'bob@libredb.test',
        level: 'read',
        expiresAt: null,
        grantedById: 'user-alice',
        grantedAt: NOW,
        updatedAt: NOW,
      },
    ])
    // The grant and its admin action are written in one transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.connectionGrant.upsert).toHaveBeenCalledTimes(1)
    expect(tx.adminAction.create).toHaveBeenCalledTimes(1)
    expect(db.connectionGrant.upsert).not.toHaveBeenCalled()
    expect(db.adminAction.create).not.toHaveBeenCalled()
    expect(tables.adminAction).toEqual([
      {
        actorId: 'user-alice',
        action: 'grant.create',
        targetType: 'grant',
        targetId: 'grant-1',
        before: Prisma.DbNull,
        after: {
          connectionId: 'conn-orders',
          subjectKind: 'user',
          subject: BOB,
          subjectUsername: 'bob',
          subjectEmail: 'bob@libredb.test',
          level: 'read',
          expiresAt: null,
          selfGrant: false,
        },
      },
    ])
    expect(revalidatePath).toHaveBeenCalledWith('/connections/conn-orders')

    // A Keycloak user without an email is granted with an empty email snapshot.
    expect((await grant({ subject: DAVE })).success).toBe(true)
    expect(tables.connectionGrant[1]).toMatchObject({ subject: DAVE, subjectUsername: 'dave', subjectEmail: null })
  })

  it('a second call updates the level instead of failing', async () => {
    await grant()

    // Another admin changes the grant later, after bob's email changed in Keycloak.
    vi.setSystemTime(LATER)
    caller.id = 'user-grace'
    directory.users.set(BOB, directoryUser(BOB, 'bob', { email: 'bob@example.test' }))
    const expiresAt = new Date(LATER.getTime() + 7 * DAY_MS)
    const result = await grant({ level: 'write', expiresAt })

    expect(result).toEqual({ success: true, data: { id: 'grant-1' } })
    // The row holds the grant as it was last set: the new level and expiry, the fresh snapshot, and who set it when.
    expect(tables.connectionGrant).toEqual([
      expect.objectContaining({
        id: 'grant-1',
        subject: BOB,
        level: 'write',
        expiresAt,
        subjectEmail: 'bob@example.test',
        grantedById: 'user-grace',
        grantedAt: LATER,
      }),
    ])
    expect(tables.adminAction.map((action) => action.action)).toEqual(['grant.create', 'grant.update'])
    expect(tables.adminAction[1]).toEqual({
      actorId: 'user-grace',
      action: 'grant.update',
      targetType: 'grant',
      targetId: 'grant-1',
      before: {
        connectionId: 'conn-orders',
        subjectKind: 'user',
        subject: BOB,
        subjectUsername: 'bob',
        subjectEmail: 'bob@libredb.test',
        level: 'read',
        expiresAt: null,
      },
      after: {
        connectionId: 'conn-orders',
        subjectKind: 'user',
        subject: BOB,
        subjectUsername: 'bob',
        subjectEmail: 'bob@example.test',
        level: 'write',
        expiresAt: expiresAt.toISOString(),
        selfGrant: false,
      },
    })
  })

  it("a grant to the actor's own Keycloak id is recorded as a self-grant", async () => {
    const result = await grant({ subject: ALICE, level: 'write' })

    expect(result.success).toBe(true)
    expect(tables.adminAction).toEqual([
      expect.objectContaining({
        actorId: 'user-alice',
        action: 'grant.create',
        after: expect.objectContaining({ subject: ALICE, subjectUsername: 'alice', selfGrant: true }),
      }),
    ])

    // Another admin granting alice makes no self-grant.
    caller.id = 'user-grace'
    await grant({ subject: ALICE, level: 'read' })
    expect(tables.adminAction[1]).toMatchObject({
      actorId: 'user-grace',
      action: 'grant.update',
      after: { subject: ALICE, selfGrant: false },
    })
  })

  it('is refused while the directory is degraded', async () => {
    caller.directoryDegraded = true

    const result = await grant()

    expect(result).toEqual({ success: false, error: 'Permission denied: the Keycloak directory is unreachable' })
    expect(directory.getUser).not.toHaveBeenCalled()
    expect(tables.connectionGrant).toEqual([])
    expect(tables.adminAction).toEqual([])

    // A directory that stops answering during the action refuses as well, with the error of the Admin API client.
    caller.directoryDegraded = false
    directory.getUser.mockRejectedValueOnce(
      new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} did not answer within 5 s'),
    )
    const unreachable = await grant()

    expect(unreachable).toEqual({
      success: false,
      error: 'Keycloak Admin API GET /users/{id} did not answer within 5 s',
    })
    expect(tables.connectionGrant).toEqual([])
    expect(tables.adminAction).toEqual([])
  })

  it('requires connection.edit and a level, subject and expiry of the right shape', async () => {
    caller.permissions = ['connection.view']
    expect(await grant()).toEqual({ success: false, error: 'Permission denied: connection.edit' })

    caller.permissions = ['connection.view', 'connection.edit']
    const malformed = await setConnectionGrant({
      connectionId: 'conn-orders',
      subject: 'x'.repeat(513),
      level: 'admin',
    } as unknown as SetInput)
    expect(malformed).toEqual({
      success: false,
      error: 'Validation failed',
      fieldErrors: {
        subject: [expect.any(String)],
        level: [expect.any(String)],
        expiresAt: ['must be a date, or null for a grant that does not expire'],
      },
    })
    expect(directory.getUser).not.toHaveBeenCalled()
    expect(tables.connectionGrant).toEqual([])
  })
})

describe('setConnectionGrant and the license of the install', () => {
  // alice, grace and dave take the three user seats of the free tier; grace's grant expires tomorrow.
  function takeTheFreeSeats() {
    tables.connectionGrant = [
      storedGrant('conn-orders', ALICE, 'alice'),
      storedGrant('conn-orders', GRACE, 'grace', { expiresAt: new Date(NOW.getTime() + DAY_MS) }),
      storedGrant('conn-orders', DAVE, 'dave'),
    ]
  }

  it('refuses a user without a seat once every user seat is taken, and after expiry, and writes nothing', async () => {
    takeTheFreeSeats()
    const before = tables.connectionGrant.map((row) => ({ ...row }))

    expect(await grant({ subject: BOB })).toEqual(USER_SEATS_REFUSAL)

    license.status = EXPIRED
    expect(await grant({ subject: BOB })).toEqual(EXPIRED_REFUSAL)

    expect(tables.connectionGrant).toEqual(before)
    expect(tables.adminAction).toEqual([])
  })

  it('changes the level or the expiry of a seat holder, and grants a holder another connection, at the limit and after expiry', async () => {
    for (const status of [FREE, EXPIRED]) {
      takeTheFreeSeats()
      tables.adminAction = []
      license.status = status
      const extended = new Date(NOW.getTime() + 7 * DAY_MS)

      expect((await grant({ subject: ALICE, level: 'write' })).success, status.state).toBe(true)
      expect((await grant({ subject: GRACE, expiresAt: extended })).success, status.state).toBe(true)
      expect((await grant({ connectionId: 'conn-reports', subject: DAVE })).success, status.state).toBe(true)

      expect(tables.connectionGrant.map((row) => [row.connectionId, row.subjectUsername, row.level, row.expiresAt])).toEqual([
        ['conn-orders', 'alice', 'write', null],
        ['conn-orders', 'grace', 'read', extended],
        ['conn-orders', 'dave', 'read', null],
        ['conn-reports', 'dave', 'read', null],
      ])
      expect(tables.adminAction.map((action) => action.action)).toEqual(['grant.update', 'grant.update', 'grant.create'])
    }
  })

  it('grants a user without a seat on a paused connection, and changes that grant, at the limit and after expiry, while the same grant on an active connection is refused', async () => {
    tables.databaseConnection.push(connection('conn-paused', { name: 'Paused', active: false }))
    for (const [status, refusal] of [
      [FREE, USER_SEATS_REFUSAL],
      [EXPIRED, EXPIRED_REFUSAL],
    ] as const) {
      takeTheFreeSeats()
      tables.adminAction = []
      license.status = status

      expect(await grant({ subject: BOB }), status.state).toEqual(refusal)
      // A grant on a paused connection gives bob no access until it is active again, so it takes no seat.
      expect((await grant({ connectionId: 'conn-paused', subject: BOB })).success, status.state).toBe(true)
      const changed = await grant({ connectionId: 'conn-paused', subject: BOB, level: 'write' })
      expect(changed.success, status.state).toBe(true)

      const bob = tables.connectionGrant.filter((row) => row.subject === BOB)
      expect(bob.map((row) => [row.connectionId, row.level]), status.state).toEqual([['conn-paused', 'write']])
      expect(tables.adminAction.map((action) => action.action), status.state).toEqual(['grant.create', 'grant.update'])
    }
  })

  it('locks the install tenant with the first statement of the transaction, after Keycloak answered', async () => {
    expect((await grant()).success).toBe(true)

    const [lock] = tx.$queryRaw.mock.calls
    expect(locksTenant(statementText(lock[0]))).toBe(true)
    expect(lock.slice(1)).toEqual(['tenant-1'])
    const locked = tx.$queryRaw.mock.invocationCallOrder[0]
    for (const step of [tx.connectionGrant.findUnique, tx.user.findUnique, tx.connectionGrant.upsert, tx.adminAction.create]) {
      expect(step.mock.invocationCallOrder[0]).toBeGreaterThan(locked)
    }
    // Keycloak answers before the transaction begins, so no HTTP call runs while the lock is held.
    expect(directory.getUser.mock.invocationCallOrder[0]).toBeLessThan(db.$transaction.mock.invocationCallOrder[0])
  })

  it('grants any number of users in cloud mode, which has no license status, and takes no lock', async () => {
    takeTheFreeSeats()
    license.status = null

    expect((await grant({ subject: BOB })).success).toBe(true)

    expect(tables.connectionGrant.map((row) => row.subjectUsername)).toEqual(['alice', 'grace', 'dave', 'bob'])
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })
})
