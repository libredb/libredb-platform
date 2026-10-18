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

// The plan of the caller's tenant, which the real checkLimit reads through db.tenant.
const plan = vi.hoisted(() => ({ maxUsers: 10 }))

// An in-memory stand-in for the Prisma client that honours the where clause
// for the lookups inviteUser makes; nested relation filters match nothing.
const { db, tables } = vi.hoisted(() => {
  const tables: Record<'role' | 'tenantMember' | 'invitation', Row[]> = {
    role: [],
    tenantMember: [],
    invitation: [],
  }
  const matches = (row: Row, where: Where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const findOne = (table: keyof typeof tables) =>
    vi.fn(async ({ where }: { where: Where }) => tables[table].find((row) => matches(row, where)) ?? null)

  const db = {
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        planConfig: { maxUsers: plan.maxUsers, maxConnections: 10, queryHistoryDays: 30 },
      })),
    },
    role: {
      findUnique: findOne('role'),
      findFirst: findOne('role'),
    },
    tenantMember: {
      findFirst: findOne('tenantMember'),
      count: vi.fn(async ({ where }: { where: Where }) => tables.tenantMember.filter((row) => matches(row, where)).length),
    },
    invitation: {
      findUnique: findOne('invitation'),
      upsert: vi.fn(async ({ create }: { create: Row }) => {
        const row = { id: `invitation-${tables.invitation.length}`, ...create }
        tables.invitation.push(row)
        return row
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

import { inviteUser } from './invite-user'

const denied = { success: false, error: expect.stringMatching(/^Permission denied/) }

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
  plan.maxUsers = 10
  tables.role = [
    { id: 'role-platform-admin', code: 'PLATFORM_ADMIN', name: 'PLATFORM_ADMIN', isSystem: true, tenantId: null },
    { id: 'role-tenant-editor', code: 'TENANT_EDITOR', name: 'TENANT_EDITOR', isSystem: true, tenantId: null },
    { id: 'role-analyst-1', code: 'DATA_ANALYST', name: 'Data Analyst', isSystem: false, tenantId: 'tenant-1' },
    { id: 'role-analyst-2', code: 'DATA_ANALYST', name: 'Data Analyst', isSystem: false, tenantId: 'tenant-2' },
  ]
  tables.tenantMember = [{ id: 'member-1', tenantId: 'tenant-1', userId: 'user-1', active: true }]
  tables.invitation = []
})

describe('inviteUser', () => {
  it('inviteUser refuses the PLATFORM_ADMIN role id', async () => {
    const result = await inviteUser({ email: 'mallory@acme.test', roleId: 'role-platform-admin' })

    expect(result).toEqual(denied)
    expect(tables.invitation).toEqual([])
  })

  it('refuses a custom role of another tenant and an unknown role id', async () => {
    for (const roleId of ['role-analyst-2', 'role-unknown']) {
      expect(await inviteUser({ email: 'mallory@acme.test', roleId }), roleId).toEqual(denied)
    }
    expect(tables.invitation).toEqual([])
  })

  it('invites with a tenant-assignable system role or a custom role of the caller tenant', async () => {
    for (const [email, roleId] of [['erin@acme.test', 'role-tenant-editor'], ['dave@acme.test', 'role-analyst-1']]) {
      expect((await inviteUser({ email, roleId })).success, roleId).toBe(true)
    }
    expect(tables.invitation).toEqual([
      expect.objectContaining({ tenantId: 'tenant-1', email: 'erin@acme.test', roleId: 'role-tenant-editor' }),
      expect.objectContaining({ tenantId: 'tenant-1', email: 'dave@acme.test', roleId: 'role-analyst-1' }),
    ])
  })

  it('a refusal names the limit of the plan, also when more members are active than a lowered limit allows', async () => {
    plan.maxUsers = 2
    tables.tenantMember.push({ id: 'member-2', tenantId: 'tenant-1', userId: 'user-2', active: true })
    // An inactive membership takes no place.
    tables.tenantMember.push({ id: 'member-3', tenantId: 'tenant-1', userId: 'user-3', active: false })

    expect(await inviteUser({ email: 'erin@acme.test', roleId: 'role-tenant-editor' })).toEqual({
      success: false,
      error: 'Limit exceeded: users (max: 2)',
    })

    // The plan allowed three before an admin lowered its limit to two.
    tables.tenantMember.push({ id: 'member-4', tenantId: 'tenant-1', userId: 'user-4', active: true })

    expect(await inviteUser({ email: 'erin@acme.test', roleId: 'role-tenant-editor' })).toEqual({
      success: false,
      error: 'Limit exceeded: users (max: 2)',
    })
    expect(tables.invitation).toEqual([])
  })
})

describe('self-hosted mode', () => {
  beforeEach(() => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  })

  it('self-hosted: throws Forbidden', async () => {
    const result = await inviteUser({ email: 'erin@acme.test', roleId: 'role-tenant-editor' })

    expect(result).toEqual({ success: false, error: 'Permission denied: not available in self-hosted mode' })
    expect(tables.invitation).toEqual([])
  })
})
