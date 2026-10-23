import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.fn()
const findAll = vi.fn()

// The plans of the tenants, which the real hasFeature reads through db.tenant, as the FeatureGate of the audit page does.
const plans = vi.hoisted(() => ({ featureAuditLog: {} as Record<string, boolean> }))

// getApiUser reads the Auth.js session, so the session is the only source of the tenant.
vi.mock('@/shared/lib/auth', () => ({ auth: () => auth() }))

// The route validates with the reader's filter schema, so the database is reached only for the plan of the tenant.
vi.mock('@/shared/lib/db', () => ({
  db: {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        planConfig: { featureAuditLog: plans.featureAuditLog[where.id] ?? false },
      }),
    },
  },
}))

vi.mock('@/features/audit/lib/audit.repository', () => ({
  AuditRepository: { findAll: (...args: unknown[]) => findAll(...args) },
}))

import { GET } from './route'

describe('GET /api/db/audit', () => {
  beforeEach(() => {
    auth.mockReset()
    findAll.mockReset()
    // The session tenant's plan has the audit log, and the tenant of the query string has none.
    plans.featureAuditLog = { 'tenant-session': true }
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
    expect(await res.json()).toEqual({ error: 'Invalid audit filters: limit' })
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
    expect(await res.json()).toEqual({ error: 'Permission denied: audit.view required' })
    expect(findAll).not.toHaveBeenCalled()
  })

  it('answers 403 when the plan of the session tenant lacks the audit log, even for PLATFORM_ADMIN, as the page does', async () => {
    plans.featureAuditLog = { 'tenant-session': false, 'tenant-other': true }

    for (const roles of [['TENANT_ADMIN'], ['PLATFORM_ADMIN']]) {
      auth.mockResolvedValue({
        user: { id: 'user-1', email: 'admin@acme.com', name: 'Admin' },
        currentTenantId: 'tenant-session',
        membershipId: 'member-1',
        roles,
        permissions: ['audit.view'],
        accessibleTenants: [],
      })

      const res = await GET(new Request('http://localhost/api/db/audit?tenantId=tenant-other'))

      expect(res.status, roles[0]).toBe(403)
      expect(await res.json(), roles[0]).toEqual({ error: 'This feature requires a plan upgrade' })
    }
    expect(findAll).not.toHaveBeenCalled()
  })
})
