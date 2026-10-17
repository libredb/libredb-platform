import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>
type Where = Record<string, unknown>

// An in-memory stand-in for platform.database_connections that honours the where clause of the finders.
const { db, tables } = vi.hoisted(() => {
  const tables: { databaseConnection: Row[] } = { databaseConnection: [] }
  const matches = (row: Row, where: Where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const db = {
    databaseConnection: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        tables.databaseConnection.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const row = tables.databaseConnection.find((candidate) => matches(candidate, where))
        return row ? { ...row } : null
      }),
    },
  }
  return { db, tables }
})

vi.mock('@/shared/lib/db', () => ({ db }))

import { DatabaseConnectionRepository } from './database-connection.repository'

const READ_KID = '0123456789abcdef'
const WRITE_KID = 'fedcba9876543210'
const READ_SECRET = `lsb1.${READ_KID}.${'A'.repeat(43)}.${'B'.repeat(30)}`
const WRITE_SECRET = `lsb1.${WRITE_KID}.${'C'.repeat(43)}.${'D'.repeat(30)}`

function connection(id: string, overrides: Row): Row {
  return {
    id,
    tenantId: 'tenant-1',
    name: id,
    engine: 'postgres',
    environment: null,
    groupName: null,
    color: null,
    definition: { host: 'db.internal', database: 'orders' },
    readSecret: READ_SECRET,
    writeSecret: null,
    mcpEnabled: false,
    active: true,
    deletedAt: null,
    createdById: 'user-alice',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  tables.databaseConnection = [
    connection('conn-orders', {
      definition: { host: 'db.internal', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } },
      writeSecret: WRITE_SECRET,
    }),
    connection('conn-oracle', { engine: 'oracle', definition: { host: 'ora.internal', port: 1521, serviceName: 'ORCLPDB1' } }),
    connection('conn-mssql', { engine: 'mssql', definition: { host: 'sql.internal', instanceName: 'SQLEXPRESS', database: 'orders' } }),
    connection('conn-redis', { engine: 'redis', definition: { host: 'cache.internal', database: '2' } }),
    connection('conn-mongo', { engine: 'mongodb', definition: { host: 'mongo.internal', port: 27017 } }),
    connection('conn-paused', { active: false }),
    connection('conn-gone', { active: false, deletedAt: new Date('2026-10-02T00:00:00Z') }),
    connection('conn-foreign', { tenantId: 'tenant-2' }),
  ]
})

describe('DatabaseConnectionRepository', () => {
  it('lists the tenant connections that are not deleted, with kids, the write flag and a host summary but no envelope', async () => {
    const connections = await DatabaseConnectionRepository.findAllByTenant('tenant-1')

    expect(connections.map((found) => [found.id, found.hostSummary, found.active])).toEqual([
      ['conn-orders', 'db.internal:5432/orders', true],
      ['conn-oracle', 'ora.internal:1521/ORCLPDB1', true],
      ['conn-mssql', 'sql.internal\\SQLEXPRESS/orders', true],
      ['conn-redis', 'cache.internal/2', true],
      ['conn-mongo', 'mongo.internal:27017', true],
      ['conn-paused', 'db.internal/orders', false],
    ])
    expect(connections[0]).toMatchObject({ hasWriteCredential: true, readKid: READ_KID, writeKid: WRITE_KID })
    expect(connections[1]).toMatchObject({ hasWriteCredential: false, readKid: READ_KID, writeKid: null })
    for (const found of connections) {
      expect(Object.keys(found)).not.toContain('readSecret')
      expect(Object.keys(found)).not.toContain('writeSecret')
    }
    expect(JSON.stringify(connections)).not.toContain('lsb1.')
  })

  it('finds a connection by id only within its tenant and only while it is not deleted', async () => {
    const found = await DatabaseConnectionRepository.findById('tenant-1', 'conn-orders')

    expect(found).toMatchObject({
      id: 'conn-orders',
      engine: 'postgres',
      definition: { host: 'db.internal', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } },
      hasWriteCredential: true,
    })
    expect(JSON.stringify(found)).not.toContain('lsb1.')

    for (const [tenantId, id] of [['tenant-1', 'conn-foreign'], ['tenant-1', 'conn-gone'], ['tenant-2', 'conn-orders']]) {
      await expect(DatabaseConnectionRepository.findById(tenantId, id), `${tenantId} ${id}`).rejects.toThrow(
        'Connection not found',
      )
    }
  })
})
