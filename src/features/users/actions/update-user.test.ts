import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Row = Record<string, unknown>
type Where = Record<string, unknown>

const caller = vi.hoisted(() => ({
  id: 'user-1',
  email: 'admin@acme.test',
  name: 'Acme Admin',
  currentTenantId: 'tenant-1',
  membershipId: 'member-1',
  roles: ['TENANT_ADMIN'],
  permissions: ['settings.edit', 'user.edit', 'user.invite'],
  accessibleTenants: [],
}))

// An in-memory stand-in for the Prisma client that honours the where clause,
// so a lookup that is not scoped to the caller's tenant finds foreign rows.
const { db, tables } = vi.hoisted(() => {
  const tables: Record<'role' | 'tenantMember' | 'userRole', Row[]> = {
    role: [],
    tenantMember: [],
    userRole: [],
  }
  const matches = (row: Row, where: Where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const findOne = (table: keyof typeof tables) =>
    vi.fn(async ({ where }: { where: Where }) => tables[table].find((row) => matches(row, where)) ?? null)

  const db = {
    role: {
      findUnique: findOne('role'),
      findFirst: findOne('role'),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `role-created-${tables.role.length}`, ...data }
        tables.role.push(row)
        return row
      }),
    },
    tenantMember: {
      findUnique: findOne('tenantMember'),
      findFirst: findOne('tenantMember'),
      update: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const row = tables.tenantMember.find((candidate) => matches(candidate, where))
        if (!row) throw new Error('Record to update not found')
        return Object.assign(row, data)
      }),
    },
    userRole: {
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const kept = tables.userRole.filter((row) => !matches(row, where))
        const count = tables.userRole.length - kept.length
        tables.userRole = kept
        return { count }
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        tables.userRole.push(data)
        return data
      }),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(db)),
  }
  return { db, tables }
})

vi.mock('@/shared/lib/db', () => ({ db }))

vi.mock('@/shared/lib/auth-utils', () => ({
  getCurrentUser: vi.fn().mockResolvedValue(caller),
  requirePermission: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { updateUserRole, toggleUserActive } from './update-user'
import { createCustomRole } from './manage-roles'

const copy = (rows: Row[]) => rows.map((row) => ({ ...row }))
const denied = { success: false, error: expect.stringMatching(/^Permission denied/) }

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
  tables.role = [
    { id: 'role-platform-admin', code: 'PLATFORM_ADMIN', name: 'PLATFORM_ADMIN', isSystem: true, tenantId: null },
    { id: 'role-tenant-admin', code: 'TENANT_ADMIN', name: 'TENANT_ADMIN', isSystem: true, tenantId: null },
    { id: 'role-tenant-viewer', code: 'TENANT_VIEWER', name: 'TENANT_VIEWER', isSystem: true, tenantId: null },
    { id: 'role-analyst-1', code: 'DATA_ANALYST', name: 'Data Analyst', isSystem: false, tenantId: 'tenant-1' },
    { id: 'role-analyst-2', code: 'DATA_ANALYST', name: 'Data Analyst', isSystem: false, tenantId: 'tenant-2' },
  ]
  tables.tenantMember = [
    { id: 'member-1', tenantId: 'tenant-1', userId: 'user-1', active: true },
    { id: 'member-2', tenantId: 'tenant-1', userId: 'user-2', active: true },
    { id: 'member-other', tenantId: 'tenant-2', userId: 'user-3', active: true },
  ]
  tables.userRole = [
    { membershipId: 'member-1', roleId: 'role-tenant-admin' },
    { membershipId: 'member-2', roleId: 'role-tenant-viewer' },
    { membershipId: 'member-other', roleId: 'role-tenant-admin' },
  ]
})

describe('updateUserRole', () => {
  it('updateUserRole answers NotFound for a membership of another tenant', async () => {
    const before = copy(tables.userRole)

    const result = await updateUserRole({ membershipId: 'member-other', roleId: 'role-tenant-viewer' })

    expect(result).toEqual({ success: false, error: 'Membership not found' })
    expect(tables.userRole).toEqual(before)
  })

  it('updateUserRole refuses the PLATFORM_ADMIN system role and a custom role of another tenant', async () => {
    const before = copy(tables.userRole)

    for (const roleId of ['role-platform-admin', 'role-analyst-2']) {
      expect(await updateUserRole({ membershipId: 'member-2', roleId }), roleId).toEqual(denied)
    }
    expect(tables.userRole).toEqual(before)
  })

  it('assigns a tenant-assignable system role or a custom role of the caller tenant', async () => {
    expect(await updateUserRole({ membershipId: 'member-2', roleId: 'role-analyst-1' })).toEqual({
      success: true,
      data: { success: true },
    })
    expect(tables.userRole.filter((row) => row.membershipId === 'member-2')).toEqual([
      { membershipId: 'member-2', roleId: 'role-analyst-1' },
    ])

    expect((await updateUserRole({ membershipId: 'member-2', roleId: 'role-tenant-admin' })).success).toBe(true)
    expect(tables.userRole.filter((row) => row.membershipId === 'member-2')).toEqual([
      { membershipId: 'member-2', roleId: 'role-tenant-admin' },
    ])
  })
})

describe('toggleUserActive', () => {
  it('toggleUserActive answers NotFound across tenants', async () => {
    const result = await toggleUserActive({ membershipId: 'member-other', active: false })

    expect(result).toEqual({ success: false, error: 'Membership not found' })
    expect(tables.tenantMember.find((row) => row.id === 'member-other')?.active).toBe(true)
  })

  it('deactivates a membership of the caller tenant', async () => {
    const result = await toggleUserActive({ membershipId: 'member-2', active: false })

    expect(result).toEqual({ success: true, data: { success: true } })
    expect(tables.tenantMember.find((row) => row.id === 'member-2')?.active).toBe(false)
  })
})

describe('the TENANT_ADMIN to PLATFORM_ADMIN escalation', () => {
  it('createCustomRole with code PLATFORM_ADMIN and then updateUserRole on the caller own membership fail at both steps', async () => {
    const created = await createCustomRole({ name: 'Platform Admin', code: 'PLATFORM_ADMIN' })

    expect(created).toEqual(denied)
    expect(tables.role.filter((row) => row.code === 'PLATFORM_ADMIN' && row.isSystem === false)).toEqual([])

    // The second step with the system role, and with a forged row left by the
    // escalation before this fix.
    tables.role.push({ id: 'role-forged', code: 'PLATFORM_ADMIN', name: 'Platform Admin', isSystem: false, tenantId: 'tenant-1' })
    const before = copy(tables.userRole)

    for (const roleId of ['role-platform-admin', 'role-forged']) {
      expect(await updateUserRole({ membershipId: caller.membershipId, roleId }), roleId).toEqual(denied)
    }
    expect(tables.userRole).toEqual(before)
  })
})

describe('self-hosted mode', () => {
  beforeEach(() => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  })

  it('self-hosted: updateUserRole and toggleUserActive throw Forbidden', async () => {
    const before = copy(tables.tenantMember)
    const roles = copy(tables.userRole)
    const refused = { success: false, error: 'Permission denied: not available in self-hosted mode' }

    expect(await updateUserRole({ membershipId: 'member-2', roleId: 'role-analyst-1' })).toEqual(refused)
    expect(await toggleUserActive({ membershipId: 'member-2', active: false })).toEqual(refused)
    expect(tables.userRole).toEqual(roles)
    expect(tables.tenantMember).toEqual(before)
  })
})
