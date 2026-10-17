import { beforeEach, describe, expect, it, vi } from 'vitest'

const caller = vi.hoisted(() => ({
  id: 'user-1',
  email: 'admin@libredb.test',
  name: 'Tenant Admin',
  currentTenantId: 'tenant-1',
  membershipId: 'member-1',
  roles: ['TENANT_ADMIN'],
  permissions: [],
  accessibleTenants: [],
}))

const db = vi.hoisted(() => ({
  tenant: {
    findUnique: vi.fn(),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'tenant-1', ...data })),
  },
}))

vi.mock('@/shared/lib/db', () => ({ db }))

vi.mock('@/shared/lib/auth-utils', () => ({
  getCurrentUser: vi.fn().mockResolvedValue(caller),
  requirePermission: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { updateSettings } from './update-settings'

beforeEach(() => {
  vi.clearAllMocks()
  db.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', name: 'Acme', logoUrl: null, settings: { locale: 'en' } })
})

describe('updateSettings', () => {
  // The UI is English only, so a tenant has no locale to choose, and the action leaves the stored settings alone.
  it('saves the name and the logo, and no locale', async () => {
    const result = await updateSettings({ name: 'Acme Corp', logoUrl: '', locale: 'tr' } as never)

    expect(result).toEqual({ success: true, data: { id: 'tenant-1', name: 'Acme Corp', logoUrl: null } })
    expect(db.tenant.update).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      data: { name: 'Acme Corp', logoUrl: null },
    })
  })
})
