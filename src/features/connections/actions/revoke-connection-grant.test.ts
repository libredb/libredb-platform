import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Row = Record<string, unknown>
type Where = Record<string, unknown>

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
// A grant's `where` may filter on its connection, as Prisma's relation filter does.
const { db, tx, tables } = vi.hoisted(() => {
  const tables: { databaseConnection: Row[]; connectionGrant: Row[]; adminAction: Row[] } = {
    databaseConnection: [],
    connectionGrant: [],
    adminAction: [],
  }
  const matches = (row: Row, where: Where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const grantMatches = (row: Row, { connection, ...where }: Where) => {
    if (!matches(row, where)) return false
    if (connection === undefined) return true
    const owner = tables.databaseConnection.find((candidate) => candidate.id === row.connectionId)
    return owner !== undefined && matches(owner, connection as Where)
  }
  const client = () => ({
    connectionGrant: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const row = tables.connectionGrant.find((candidate) => grantMatches(candidate, where))
        return row ? { ...row } : null
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const kept = tables.connectionGrant.filter((row) => !grantMatches(row, where))
        const count = tables.connectionGrant.length - kept.length
        tables.connectionGrant = kept
        return { count }
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
        connectionGrant: tables.connectionGrant.map((row) => ({ ...row })),
        adminAction: [...tables.adminAction],
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

import { revokeConnectionGrant } from './revoke-connection-grant'

// Keycloak user ids of the fixture realm, tests/fixtures/keycloak/libredb-test-realm.json.
const BOB = '00000000-0000-4000-8000-000000000b0b'
const ERIN = '00000000-0000-4000-8000-00000000e121'

const EXPIRES_AT = new Date('2026-11-01T00:00:00.000Z')

function connection(id: string, overrides: Row = {}): Row {
  return { id, tenantId: 'tenant-1', name: 'Orders', active: true, deletedAt: null, ...overrides }
}

function grant(id: string, connectionId: string, subject: string, username: string, overrides: Row = {}): Row {
  return {
    id,
    connectionId,
    subjectKind: 'user',
    subject,
    subjectUsername: username,
    subjectEmail: `${username}@libredb.test`,
    level: 'read',
    expiresAt: null,
    grantedById: 'user-alice',
    grantedAt: new Date('2026-10-14T08:00:00.000Z'),
    updatedAt: new Date('2026-10-14T08:00:00.000Z'),
    ...overrides,
  }
}

beforeEach(() => {
  caller.permissions = ['connection.view', 'connection.create', 'connection.edit', 'connection.delete']
  caller.directoryDegraded = false
  tables.databaseConnection = [
    connection('conn-orders'),
    connection('conn-gone', { active: false, deletedAt: new Date('2026-10-02T00:00:00Z') }),
    connection('conn-foreign', { tenantId: 'tenant-2', name: 'Billing' }),
  ]
  tables.connectionGrant = [
    grant('grant-bob', 'conn-orders', BOB, 'bob', { level: 'write' }),
    grant('grant-erin', 'conn-orders', ERIN, 'erin', { expiresAt: EXPIRES_AT }),
    grant('grant-gone', 'conn-gone', BOB, 'bob'),
    grant('grant-foreign', 'conn-foreign', BOB, 'bob'),
  ]
  tables.adminAction = []
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('revokeConnectionGrant', () => {
  it('deletes the grant and records an admin action', async () => {
    const result = await revokeConnectionGrant({ grantId: 'grant-erin' })

    expect(result).toEqual({ success: true, data: { id: 'grant-erin' } })
    expect(tables.connectionGrant.map((row) => row.id)).toEqual(['grant-bob', 'grant-gone', 'grant-foreign'])
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.connectionGrant.deleteMany).toHaveBeenCalledTimes(1)
    expect(db.connectionGrant.deleteMany).not.toHaveBeenCalled()
    expect(tables.adminAction).toEqual([
      {
        actorId: 'user-alice',
        channel: 'web',
        action: 'grant.revoke',
        targetType: 'grant',
        targetId: 'grant-erin',
        before: {
          connectionId: 'conn-orders',
          subjectKind: 'user',
          subject: ERIN,
          subjectUsername: 'erin',
          subjectEmail: 'erin@libredb.test',
          level: 'read',
          expiresAt: EXPIRES_AT.toISOString(),
        },
        after: Prisma.DbNull,
      },
    ])
    expect(revalidatePath).toHaveBeenCalledWith('/connections/conn-orders')

    // A revoke reads nothing from Keycloak, so it narrows access also while the directory is degraded.
    caller.directoryDegraded = true
    expect(await revokeConnectionGrant({ grantId: 'grant-bob' })).toEqual({ success: true, data: { id: 'grant-bob' } })
    expect(tables.connectionGrant.map((row) => row.id)).toEqual(['grant-gone', 'grant-foreign'])

    caller.permissions = ['connection.view']
    expect(await revokeConnectionGrant({ grantId: 'grant-gone' })).toEqual({
      success: false,
      error: 'Permission denied: connection.edit',
    })
  })

  it('a grant of another tenant answers NotFound', async () => {
    const before = tables.connectionGrant.map((row) => ({ ...row }))

    // A grant on a deleted connection is gone with its connection, and an unknown id is no grant.
    for (const grantId of ['grant-foreign', 'grant-gone', 'grant-unknown']) {
      const result = await revokeConnectionGrant({ grantId })

      expect(result, grantId).toEqual({ success: false, error: 'Grant not found' })
    }
    expect(tables.connectionGrant).toEqual(before)
    expect(tables.adminAction).toEqual([])

    // A grant that another admin revoked after this one read it is not found either, and nothing is recorded.
    tx.connectionGrant.deleteMany.mockResolvedValueOnce({ count: 0 })
    expect(await revokeConnectionGrant({ grantId: 'grant-bob' })).toEqual({ success: false, error: 'Grant not found' })
    expect(tables.adminAction).toEqual([])
  })
})
