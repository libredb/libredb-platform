import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PERMISSIONS } from '@/shared/lib/permissions'

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
  const tables: Record<'role' | 'permission' | 'rolePermission', Row[]> = {
    role: [],
    permission: [],
    rolePermission: [],
  }
  const matches = (row: Row, where: Where) =>
    Object.entries(where).every(([key, value]) => {
      if (value !== null && typeof value === 'object' && 'in' in value) {
        return (value.in as unknown[]).includes(row[key])
      }
      return row[key] === value
    })
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
    permission: {
      findMany: vi.fn(async ({ where }: { where: Where }) => tables.permission.filter((row) => matches(row, where))),
    },
    rolePermission: {
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const kept = tables.rolePermission.filter((row) => !matches(row, where))
        const count = tables.rolePermission.length - kept.length
        tables.rolePermission = kept
        return { count }
      }),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        tables.rolePermission.push(...data)
        return { count: data.length }
      }),
    },
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

import { createCustomRole, updateRolePermissions } from './manage-roles'

const permissionId = (code: string) => `perm-${code}`
const copy = (rows: Row[]) => rows.map((row) => ({ ...row }))
const denied = { success: false, error: expect.stringMatching(/^Permission denied/) }

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
  tables.role = [
    { id: 'role-platform-admin', code: 'PLATFORM_ADMIN', name: 'PLATFORM_ADMIN', isSystem: true, tenantId: null },
    { id: 'role-tenant-viewer', code: 'TENANT_VIEWER', name: 'TENANT_VIEWER', isSystem: true, tenantId: null },
    { id: 'role-analyst-1', code: 'DATA_ANALYST', name: 'Data Analyst', isSystem: false, tenantId: 'tenant-1' },
    { id: 'role-analyst-2', code: 'DATA_ANALYST', name: 'Data Analyst', isSystem: false, tenantId: 'tenant-2' },
  ]
  tables.permission = Object.values(PERMISSIONS).map((code) => ({ id: permissionId(code), code }))
  tables.rolePermission = [
    { roleId: 'role-tenant-viewer', permissionId: permissionId(PERMISSIONS.QUERY_EXECUTE) },
    { roleId: 'role-analyst-1', permissionId: permissionId(PERMISSIONS.SCHEMA_VIEW) },
    { roleId: 'role-analyst-2', permissionId: permissionId(PERMISSIONS.SCHEMA_VIEW) },
  ]
})

describe('createCustomRole', () => {
  it('createCustomRole refuses PLATFORM_ADMIN, PLATFORM_TECH, PLATFORM_SUPPORT, TENANT_ADMIN, TENANT_EDITOR, TENANT_VIEWER and PLATFORM_X', async () => {
    const before = copy(tables.role)

    for (const code of ['PLATFORM_ADMIN', 'PLATFORM_TECH', 'PLATFORM_SUPPORT', 'TENANT_ADMIN', 'TENANT_EDITOR', 'TENANT_VIEWER', 'PLATFORM_X']) {
      expect(await createCustomRole({ name: `Forged ${code}`, code }), code).toEqual(denied)
    }
    expect(tables.role).toEqual(before)
  })

  it('creates an unreserved custom role in the caller tenant', async () => {
    const result = await createCustomRole({ name: 'Data Steward', code: 'DATA_STEWARD' })

    expect(result.success).toBe(true)
    expect(tables.role).toContainEqual(expect.objectContaining({
      code: 'DATA_STEWARD',
      name: 'Data Steward',
      tenantId: 'tenant-1',
      isSystem: false,
    }))
  })
})

describe('updateRolePermissions', () => {
  it('updateRolePermissions answers NotFound for a role of another tenant', async () => {
    const before = copy(tables.rolePermission)

    const result = await updateRolePermissions({
      roleId: 'role-analyst-2',
      permissionIds: [permissionId(PERMISSIONS.QUERY_EXECUTE)],
    })

    expect(result).toEqual({ success: false, error: 'Role not found' })
    expect(tables.rolePermission).toEqual(before)
  })

  it('refuses a system role', async () => {
    const before = copy(tables.rolePermission)

    const result = await updateRolePermissions({
      roleId: 'role-tenant-viewer',
      permissionIds: [permissionId(PERMISSIONS.QUERY_EXECUTE), permissionId(PERMISSIONS.QUERY_WRITE)],
    })

    expect(result.success).toBe(false)
    expect(tables.rolePermission).toEqual(before)
  })

  it('updateRolePermissions refuses platform.dashboard and tenant.manage', async () => {
    const before = copy(tables.rolePermission)

    for (const code of [PERMISSIONS.PLATFORM_DASHBOARD, PERMISSIONS.TENANT_MANAGE]) {
      const result = await updateRolePermissions({
        roleId: 'role-analyst-1',
        permissionIds: [permissionId(PERMISSIONS.QUERY_EXECUTE), permissionId(code)],
      })
      expect(result, code).toEqual(denied)
    }
    expect(tables.rolePermission).toEqual(before)
  })

  it('answers NotFound for an unknown permission id', async () => {
    const before = copy(tables.rolePermission)

    const result = await updateRolePermissions({
      roleId: 'role-analyst-1',
      permissionIds: [permissionId(PERMISSIONS.QUERY_EXECUTE), 'perm-unknown'],
    })

    expect(result).toEqual({ success: false, error: 'Permission not found' })
    expect(tables.rolePermission).toEqual(before)
  })

  it('replaces the permissions of a custom role of the caller tenant with tenant-assignable ones', async () => {
    const result = await updateRolePermissions({
      roleId: 'role-analyst-1',
      permissionIds: [permissionId(PERMISSIONS.QUERY_EXECUTE), permissionId(PERMISSIONS.AUDIT_VIEW)],
    })

    expect(result).toEqual({ success: true, data: { success: true } })
    expect(tables.rolePermission.filter((row) => row.roleId === 'role-analyst-1')).toEqual([
      { roleId: 'role-analyst-1', permissionId: permissionId(PERMISSIONS.QUERY_EXECUTE) },
      { roleId: 'role-analyst-1', permissionId: permissionId(PERMISSIONS.AUDIT_VIEW) },
    ])
    expect(tables.rolePermission).toContainEqual({
      roleId: 'role-analyst-2',
      permissionId: permissionId(PERMISSIONS.SCHEMA_VIEW),
    })
  })
})

describe('self-hosted mode', () => {
  beforeEach(() => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  })

  it('self-hosted: createCustomRole and updateRolePermissions throw Forbidden', async () => {
    const roles = copy(tables.role)
    const grants = copy(tables.rolePermission)
    const refused = { success: false, error: 'Permission denied: not available in self-hosted mode' }

    expect(await createCustomRole({ name: 'Data Steward', code: 'DATA_STEWARD' })).toEqual(refused)
    expect(await updateRolePermissions({
      roleId: 'role-analyst-1',
      permissionIds: [permissionId(PERMISSIONS.QUERY_EXECUTE)],
    })).toEqual(refused)
    expect(tables.role).toEqual(roles)
    expect(tables.rolePermission).toEqual(grants)
  })
})
