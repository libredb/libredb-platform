import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const caller = vi.hoisted(() => ({
  id: 'user-1',
  email: 'admin@libredb.test',
  name: 'Platform Admin',
  currentTenantId: 'tenant-1',
  membershipId: 'member-1',
  roles: ['PLATFORM_ADMIN'],
  permissions: [],
  accessibleTenants: [],
}))

const TenantRepository = vi.hoisted(() => ({
  create: vi.fn(async (data: Record<string, unknown>) => ({ id: 'tenant-new', ...data })),
}))

vi.mock('../lib/tenant.repository', () => ({ TenantRepository }))

vi.mock('@/shared/lib/auth-utils', () => ({
  getCurrentUser: vi.fn().mockResolvedValue(caller),
  requireRole: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createTenant } from './create-tenant'

const tenant = { name: 'Acme Corp', slug: 'acme', planConfigId: 'plan-free' }

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createTenant', () => {
  it('creates the tenant in cloud mode', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')

    const result = await createTenant(tenant)

    expect(result).toEqual({ success: true, data: { id: 'tenant-new', ...tenant } })
    expect(TenantRepository.create).toHaveBeenCalledWith(tenant)
  })

  it('self-hosted: throws Forbidden', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')

    const result = await createTenant(tenant)

    expect(result).toEqual({ success: false, error: 'Permission denied: not available in self-hosted mode' })
    expect(TenantRepository.create).not.toHaveBeenCalled()
  })
})
