// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CurrentUser } from '@/shared/types'
import { apiV1ErrorResponse } from '@/shared/lib/bearer/api-v1-response'
import { PERMISSIONS, SYSTEM_ROLES } from '@/shared/lib/permissions'

const findAll = vi.hoisted(() => vi.fn())
const bearer = vi.hoisted(() => ({ user: undefined as unknown }))
// The plans of the tenants, which the real hasFeature reads through db.tenant.
const plans = vi.hoisted(() => ({ featureAuditLog: {} as Record<string, boolean> }))

// withBearer is covered by the tests of GET /api/v1/me; here it hands the route the user of a bearer token and answers
// its errors with the real /api/v1 error contract.
vi.mock('@/shared/lib/bearer/with-bearer', () => ({
  withBearer:
    (handler: (user: unknown, request: Request, context: unknown) => Promise<Response>) =>
    async (request: Request, context: unknown) => {
      try {
        return await handler(bearer.user, request, context)
      } catch (error) {
        return apiV1ErrorResponse(error)
      }
    },
}))
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

// The user of a bearer token: a Platform admin of the install tenant with every permission (with-bearer.ts).
const ADMIN: CurrentUser = {
  id: 'user-alice',
  email: 'alice@libredb.test',
  name: 'Alice Admin',
  authProvider: 'keycloak',
  currentTenantId: 'tenant-install',
  membershipId: null,
  roles: [SYSTEM_ROLES.PLATFORM_ADMIN],
  permissions: Object.values(PERMISSIONS),
  accessibleTenants: [{ id: 'tenant-install', name: 'Acme', slug: 'default' }],
  directoryDegraded: false,
}

const EVENT = { eventId: 'event-1', subject: 'kc-alice', status: 'success' }

async function get(query = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await GET(new Request(`http://localhost:3100/api/v1/audit${query}`), { params: Promise.resolve({}) })
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  bearer.user = ADMIN
  plans.featureAuditLog = { 'tenant-install': true }
  findAll.mockReset().mockResolvedValue({ events: [EVENT], total: 1 })
})

describe('GET /api/v1/audit', () => {
  it('answers the events and total of the install tenant, with every filter, and ignores a tenant in the query string', async () => {
    const { status, body } = await get(
      '?tenantId=tenant-other&subject=kc-alice&connectionId=conn-1&source=key-scan&statementType=SELECT&status=refused&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z&search=orders',
    )

    expect(status).toBe(200)
    expect(body).toEqual({ events: [EVENT], total: 1 })
    expect(findAll).toHaveBeenCalledWith({
      tenantId: 'tenant-install',
      subject: 'kc-alice',
      connectionId: 'conn-1',
      source: 'key-scan',
      statementType: 'SELECT',
      status: 'refused',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-02T00:00:00.000Z'),
      search: 'orders',
      limit: 50,
      offset: 0,
    })
  })

  it('pages with limit and offset and answers the total of every matching event', async () => {
    findAll.mockResolvedValue({ events: [EVENT], total: 41 })

    const { status, body } = await get('?limit=20&offset=40')

    expect(status).toBe(200)
    expect(body).toEqual({ events: [EVENT], total: 41 })
    expect(findAll).toHaveBeenCalledWith({ tenantId: 'tenant-install', limit: 20, offset: 40 })
  })

  it('answers 400 VALIDATION_FAILED naming every bad filter', async () => {
    const { status, body } = await get('?limit=201&status=nope&from=yesterday')

    expect(status).toBe(400)
    expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    const error = body.error as { message: string; fieldErrors: Record<string, string[]> }
    expect(Object.keys(error.fieldErrors).sort()).toEqual(['from', 'limit', 'status'])
    expect(error.message).toBe('Invalid audit filters: status, from, limit')
    expect(findAll).not.toHaveBeenCalled()
  })

  it('answers 403 PLAN_FEATURE_REQUIRED when the plan of the install tenant lacks the audit log, before any filter check', async () => {
    plans.featureAuditLog = { 'tenant-install': false }

    const { status, body } = await get('?limit=201')

    expect(status).toBe(403)
    expect(body).toEqual({ error: { code: 'PLAN_FEATURE_REQUIRED', message: 'This feature requires a plan upgrade' } })
    expect(findAll).not.toHaveBeenCalled()
  })

  it('answers 403 PERMISSION_DENIED for a user without audit.view', async () => {
    bearer.user = { ...ADMIN, roles: [SYSTEM_ROLES.TENANT_VIEWER], permissions: [] }

    const { status, body } = await get()

    expect(status).toBe(403)
    expect(body).toEqual({ error: { code: 'PERMISSION_DENIED', message: 'Permission denied: audit.view required' } })
    expect(findAll).not.toHaveBeenCalled()
  })
})
