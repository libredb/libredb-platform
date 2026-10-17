import { describe, it, expect, vi } from 'vitest'

vi.mock('@prisma/client', () => {
  class MockPrismaClient {
    $connect = vi.fn()
    $disconnect = vi.fn()
    $extends = vi.fn().mockImplementation(() => ({
      $connect: vi.fn(),
    }))
  }
  return { PrismaClient: MockPrismaClient }
})

const adapterOptions = vi.hoisted(() => [] as unknown[])
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    constructor(options: unknown) {
      adapterOptions.push(options)
    }
  },
}))

import { db, createTenantClient } from './db'

describe('db', () => {
  it('should export a base Prisma client', () => {
    expect(db).toBeDefined()
    expect(db.$connect).toBeDefined()
  })

  it('should create a tenant-scoped client', () => {
    const tenantDb = createTenantClient('test-tenant-id')
    expect(tenantDb).toBeDefined()
  })

  it('the adapter gets max 10, a 5 s connect timeout, a 30 s query timeout and keepalive', () => {
    // One replica holds Prisma's 10 plus the scheduler lock pool, the budget docs/deploy/platform-runtime.md counts.
    expect(adapterOptions).toEqual([
      expect.objectContaining({
        max: 10,
        connectionTimeoutMillis: 5_000,
        query_timeout: 30_000,
        keepAlive: true,
      }),
    ])
  })
})
