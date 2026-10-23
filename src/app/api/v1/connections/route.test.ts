// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findAllByTenant = vi.hoisted(() => vi.fn())

vi.mock('@/shared/lib/bearer/with-bearer', async () => (await import('../../../../../tests/api/fake-bearer')).fakeBearerModule())
vi.mock('@/shared/lib/auth-utils', async () => (await import('../../../../../tests/api/fake-bearer')).fakeAuthUtilsModule())
vi.mock('@/shared/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/connections/lib/database-connection.repository', () => ({
  DatabaseConnectionRepository: { findAllByTenant },
}))

import { GET } from './route'

// A connection as the repository returns it, with the kids of its sealed credentials.
function view(overrides: Record<string, unknown>) {
  return {
    id: 'conn-orders',
    name: 'Orders',
    engine: 'postgres',
    environment: 'production',
    groupName: null,
    color: null,
    definition: { host: 'db.internal', port: 5432, database: 'orders' },
    hostSummary: 'db.internal:5432/orders',
    mcpEnabled: false,
    active: true,
    hasWriteCredential: true,
    readKid: 'kid-read',
    writeKid: 'kid-write',
    createdById: 'user-alice',
    createdAt: new Date('2027-01-01T00:00:00Z'),
    updatedAt: new Date('2027-01-01T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  findAllByTenant.mockReset()
})

describe('GET /api/v1/connections', () => {
  it('lists the connections of the install tenant without any credential or host', async () => {
    findAllByTenant.mockResolvedValue([
      view({}),
      view({ id: 'conn-billing', name: 'Billing', engine: 'mysql', active: false, hasWriteCredential: false, writeKid: null }),
    ])

    const response = await GET(new Request('http://localhost:3100/api/v1/connections'), { params: Promise.resolve({}) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      connections: [
        { id: 'conn-orders', name: 'Orders', engine: 'postgres', status: 'active', hasWriteCredential: true },
        { id: 'conn-billing', name: 'Billing', engine: 'mysql', status: 'inactive', hasWriteCredential: false },
      ],
    })
    expect(findAllByTenant).toHaveBeenCalledWith('tenant-install')
  })
})
