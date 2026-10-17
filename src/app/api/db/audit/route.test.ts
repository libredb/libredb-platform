import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.fn()
const findAll = vi.fn()

// getApiUser reads the Auth.js session, so the session is the only source of the tenant.
vi.mock('@/shared/lib/auth', () => ({ auth: () => auth() }))

// The route validates with the reader's filter schema; the database is never reached here.
vi.mock('@/shared/lib/db', () => ({ db: {} }))

vi.mock('@/features/audit/lib/audit.repository', () => ({
  AuditRepository: { findAll: (...args: unknown[]) => findAll(...args) },
}))

import { GET } from './route'

describe('GET /api/db/audit', () => {
  beforeEach(() => {
    auth.mockReset()
    findAll.mockReset()
    auth.mockResolvedValue({
      user: { id: 'user-1', email: 'admin@acme.com', name: 'Admin' },
      currentTenantId: 'tenant-session',
      membershipId: 'member-1',
      roles: ['TENANT_ADMIN'],
      permissions: ['audit.view'],
      accessibleTenants: [],
    })
    findAll.mockResolvedValue({ events: [], total: 0 })
  })

  it('uses the session tenant and ignores a tenant in the query string', async () => {
    const res = await GET(
      new Request(
        'http://localhost/api/db/audit?tenantId=tenant-other&subject=kc-alice&connectionId=conn-1&source=key-scan&statementType=SELECT&status=refused&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z&search=orders&limit=20&offset=40',
      ),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ events: [], total: 0 })
    expect(findAll).toHaveBeenCalledTimes(1)
    expect(findAll).toHaveBeenCalledWith({
      tenantId: 'tenant-session',
      subject: 'kc-alice',
      connectionId: 'conn-1',
      source: 'key-scan',
      statementType: 'SELECT',
      status: 'refused',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-02T00:00:00.000Z'),
      search: 'orders',
      limit: 20,
      offset: 40,
    })
  })

  it('answers 400 for limit 201', async () => {
    const res = await GET(new Request('http://localhost/api/db/audit?limit=201'))

    expect(res.status).toBe(400)
    expect(findAll).not.toHaveBeenCalled()
  })

  it('answers 403 without audit.view', async () => {
    auth.mockResolvedValue({
      user: { id: 'user-2', email: 'member@acme.com', name: null },
      currentTenantId: 'tenant-session',
      membershipId: 'member-2',
      roles: ['TENANT_MEMBER'],
      permissions: [],
      accessibleTenants: [],
    })

    const res = await GET(new Request('http://localhost/api/db/audit'))

    expect(res.status).toBe(403)
    expect(findAll).not.toHaveBeenCalled()
  })
})
