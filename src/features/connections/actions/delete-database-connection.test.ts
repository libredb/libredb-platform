import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Row = Record<string, unknown>
type Where = Record<string, unknown>

const caller = vi.hoisted(() => ({
  id: 'user-alice',
  email: 'alice@libredb.test',
  name: 'Alice',
  currentTenantId: 'tenant-1',
  membershipId: 'member-1',
  roles: ['TENANT_ADMIN'],
  permissions: ['connection.view', 'connection.create', 'connection.edit', 'connection.delete'] as string[],
  accessibleTenants: [],
}))

// An in-memory stand-in for the tables the action touches. `tx` is the client inside the one $transaction, which
// restores the tables when its callback throws, as a rolled back transaction would; `db` is the client outside it.
const { db, tx, tables } = vi.hoisted(() => {
  const tables: { databaseConnection: Row[]; connectionGrant: Row[]; adminAction: Row[] } = {
    databaseConnection: [],
    connectionGrant: [],
    adminAction: [],
  }
  const matches = (row: Row, where: Where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const client = () => ({
    databaseConnection: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const row = tables.databaseConnection.find((candidate) => matches(candidate, where))
        return row ? { ...row } : null
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const index = tables.databaseConnection.findIndex((row) => row.id === where.id)
        if (index < 0) throw new Error('Record to update not found')
        tables.databaseConnection[index] = { ...tables.databaseConnection[index], ...data, updatedAt: new Date() }
        return { ...tables.databaseConnection[index] }
      }),
    },
    connectionGrant: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        tables.connectionGrant.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const kept = tables.connectionGrant.filter((row) => !matches(row, where))
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
        databaseConnection: tables.databaseConnection.map((row) => ({ ...row })),
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

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { deleteDatabaseConnection } from './delete-database-connection'

const KID = '0123456789abcdef'
const READ_SECRET = `lsb1.${KID}.${'A'.repeat(43)}.${'B'.repeat(30)}`
const WRITE_SECRET = `lsb1.${KID}.${'C'.repeat(43)}.${'D'.repeat(30)}`
const DEFINITION = { host: 'db.internal', port: 5432, database: 'orders' }

function connection(id: string, tenantId: string, name: string): Row {
  return {
    id,
    tenantId,
    name,
    engine: 'postgres',
    environment: 'production',
    groupName: null,
    color: null,
    definition: DEFINITION,
    readSecret: READ_SECRET,
    writeSecret: WRITE_SECRET,
    mcpEnabled: false,
    active: true,
    deletedAt: null,
    createdById: 'user-alice',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  }
}

// Keycloak user ids of the fixture realm, tests/fixtures/keycloak/libredb-test-realm.json.
const BOB = '00000000-0000-4000-8000-000000000b0b'
const ERIN = '00000000-0000-4000-8000-00000000e121'

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

function row(id: string): Row {
  const found = tables.databaseConnection.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

beforeEach(() => {
  caller.permissions = ['connection.view', 'connection.create', 'connection.edit', 'connection.delete']
  tables.databaseConnection = [
    connection('conn-orders', 'tenant-1', 'Orders'),
    connection('conn-billing', 'tenant-2', 'Billing'),
  ]
  tables.connectionGrant = []
  tables.adminAction = []
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('deleteDatabaseConnection', () => {
  it('soft-deletes within the tenant and answers NotFound across tenants', async () => {
    const result = await deleteDatabaseConnection({ id: 'conn-orders' })

    expect(result).toEqual({ success: true, data: { id: 'conn-orders' } })
    // The row stays, so its query events keep their connection, and bridge.connections_v1 no longer shows it.
    expect(row('conn-orders')).toMatchObject({
      name: 'Orders',
      active: false,
      deletedAt: expect.any(Date),
      readSecret: READ_SECRET,
      writeSecret: WRITE_SECRET,
    })
    expect(tables.adminAction).toEqual([
      {
        actorId: 'user-alice',
        channel: 'web',
        action: 'connection.delete',
        targetType: 'connection',
        targetId: 'conn-orders',
        before: {
          name: 'Orders',
          engine: 'postgres',
          environment: 'production',
          groupName: null,
          color: null,
          definition: DEFINITION,
          mcpEnabled: false,
          active: true,
          readKid: KID,
          writeKid: KID,
        },
        after: Prisma.DbNull,
      },
    ])

    // A deleted connection is gone for its own tenant too, and another tenant's connection is never found.
    for (const id of ['conn-orders', 'conn-billing']) {
      expect(await deleteDatabaseConnection({ id }), id).toEqual({ success: false, error: 'Connection not found' })
    }
    expect(row('conn-billing')).toMatchObject({ active: true, deletedAt: null })
    expect(tables.adminAction).toHaveLength(1)

    caller.permissions = ['connection.view']
    const denied = await deleteDatabaseConnection({ id: 'conn-orders' })
    expect(denied).toEqual({ success: false, error: 'Permission denied: connection.delete' })
  })

  it('deleting a connection deletes its grants in the same transaction', async () => {
    tables.databaseConnection.push(connection('conn-reports', 'tenant-1', 'Reports'))
    tables.connectionGrant = [
      grant('grant-bob', 'conn-orders', BOB, 'bob', { level: 'write' }),
      grant('grant-erin', 'conn-orders', ERIN, 'erin', { expiresAt: new Date('2026-11-01T00:00:00.000Z') }),
      grant('grant-reports', 'conn-reports', BOB, 'bob'),
      grant('grant-billing', 'conn-billing', BOB, 'bob'),
    ]

    const result = await deleteDatabaseConnection({ id: 'conn-orders' })

    expect(result).toEqual({ success: true, data: { id: 'conn-orders' } })
    expect(tables.connectionGrant.map((candidate) => candidate.id)).toEqual(['grant-reports', 'grant-billing'])
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.connectionGrant.deleteMany).toHaveBeenCalledWith({ where: { connectionId: 'conn-orders' } })
    expect(db.connectionGrant.deleteMany).not.toHaveBeenCalled()
    // Each grant that goes with its connection is recorded as revoked, in the transaction that deletes the connection.
    expect(tables.adminAction.map((action) => [action.action, action.targetId])).toEqual([
      ['connection.delete', 'conn-orders'],
      ['grant.revoke', 'grant-bob'],
      ['grant.revoke', 'grant-erin'],
    ])
    expect(tables.adminAction[2]).toEqual({
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
        expiresAt: '2026-11-01T00:00:00.000Z',
      },
      after: Prisma.DbNull,
    })

    // When the grants cannot be deleted, the connection is not deleted either.
    tx.connectionGrant.deleteMany.mockRejectedValueOnce(new Error('grants refused'))
    const failed = await deleteDatabaseConnection({ id: 'conn-reports' })

    expect(failed).toEqual({ success: false, error: 'Internal server error' })
    expect(row('conn-reports')).toMatchObject({ active: true, deletedAt: null })
    expect(tables.connectionGrant.map((candidate) => candidate.id)).toEqual(['grant-reports', 'grant-billing'])
    expect(tables.adminAction).toHaveLength(3)
  })
})
