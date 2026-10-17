import { describe, expect, it, vi } from 'vitest'
import { PERMISSIONS, ROLE_PERMISSIONS } from '../permissions'
import {
  CREDENTIALS_RECHECK_SECONDS,
  loadCredentialsAccess,
  refreshCredentialsToken,
  type CredentialsSessionClient,
  type CredentialsToken,
} from './credentials-session'

type SeedRole = { code: string; isSystem: boolean; permissions: readonly string[] }

interface SeedMembership {
  id: string
  tenantId: string
  userId: string
  active: boolean
  roles: SeedRole[]
}

const SYSTEM = {
  TENANT_ADMIN: { code: 'TENANT_ADMIN', isSystem: true, permissions: ROLE_PERMISSIONS.TENANT_ADMIN },
  TENANT_EDITOR: { code: 'TENANT_EDITOR', isSystem: true, permissions: ROLE_PERMISSIONS.TENANT_EDITOR },
  TENANT_VIEWER: { code: 'TENANT_VIEWER', isSystem: true, permissions: ROLE_PERMISSIONS.TENANT_VIEWER },
} satisfies Record<string, SeedRole>

// platform.users and platform.tenant_members, answered in the shape of the Prisma selects.
function fakeDatabase(users: Record<string, { active: boolean }>, memberships: SeedMembership[]) {
  const findUser = vi.fn(async ({ where }: { where: { id: string } }) => {
    const user = users[where.id]
    return user ? { active: user.active } : null
  })
  const findMembership = vi.fn(async ({ where }: { where: { tenantId_userId: { tenantId: string; userId: string } } }) => {
    const { tenantId, userId } = where.tenantId_userId
    const membership = memberships.find(candidate => candidate.tenantId === tenantId && candidate.userId === userId)
    if (!membership) return null
    return {
      id: membership.id,
      active: membership.active,
      roles: membership.roles.map(role => ({
        role: {
          code: role.code,
          isSystem: role.isSystem,
          permissions: role.permissions.map(code => ({ permission: { code } })),
        },
      })),
    }
  })
  const client = { user: { findUnique: findUser }, tenantMember: { findUnique: findMembership } }
  return { findUser, findMembership, client: client as unknown as CredentialsSessionClient }
}

const SIGNED_IN_AT = 1_760_000_000

function tokenOf(overrides: Partial<CredentialsToken> = {}): CredentialsToken {
  return {
    id: 'user-alice',
    checkedAt: SIGNED_IN_AT,
    currentTenantId: 'tenant-acme',
    membershipId: 'membership-acme',
    roles: ['TENANT_ADMIN', 'TENANT_EDITOR'],
    permissions: [...ROLE_PERMISSIONS.TENANT_ADMIN],
    ...overrides,
  }
}

function membershipOf(roles: SeedRole[], overrides: Partial<SeedMembership> = {}): SeedMembership {
  return { id: 'membership-acme', tenantId: 'tenant-acme', userId: 'user-alice', active: true, roles, ...overrides }
}

describe('loadCredentialsAccess', () => {
  it('a custom role with a reserved code contributes no permission to a Credentials session', async () => {
    const { client } = fakeDatabase({ 'user-alice': { active: true } }, [
      membershipOf([
        SYSTEM.TENANT_VIEWER,
        // Custom roles that took reserved codes before custom roles were refused such codes.
        { code: 'PLATFORM_ADMIN', isSystem: false, permissions: [PERMISSIONS.PLATFORM_DASHBOARD, PERMISSIONS.CONNECTION_CREATE] },
        { code: 'TENANT_ADMIN', isSystem: false, permissions: [PERMISSIONS.USER_INVITE, PERMISSIONS.AUDIT_VIEW] },
        { code: 'PLATFORM_X', isSystem: false, permissions: [PERMISSIONS.SETTINGS_EDIT] },
      ]),
    ])

    const access = await loadCredentialsAccess(client, 'user-alice', 'tenant-acme')

    expect(access).toEqual({
      membershipId: 'membership-acme',
      roles: ['TENANT_VIEWER'],
      permissions: [...ROLE_PERMISSIONS.TENANT_VIEWER],
    })
  })

  it('a custom role contributes only permissions that TENANT_ADMIN holds', async () => {
    const { client } = fakeDatabase({ 'user-alice': { active: true } }, [
      membershipOf([
        {
          code: 'AUDITOR',
          isSystem: false,
          permissions: [
            PERMISSIONS.AUDIT_VIEW,
            PERMISSIONS.AUDIT_EXPORT,
            PERMISSIONS.PLATFORM_DASHBOARD,
            PERMISSIONS.TENANT_MANAGE,
            PERMISSIONS.TICKET_VIEW_ALL,
            PERMISSIONS.TAG_MANAGE,
          ],
        },
      ]),
    ])

    const access = await loadCredentialsAccess(client, 'user-alice', 'tenant-acme')

    expect(access).toEqual({
      membershipId: 'membership-acme',
      roles: ['AUDITOR'],
      permissions: [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_EXPORT],
    })
  })

  it('a system role keeps every permission it holds, each listed once', async () => {
    const platformAdmin = { code: 'PLATFORM_ADMIN', isSystem: true, permissions: ROLE_PERMISSIONS.PLATFORM_ADMIN }
    const { client } = fakeDatabase({ 'user-root': { active: true } }, [
      membershipOf([platformAdmin, SYSTEM.TENANT_ADMIN], { id: 'membership-platform', tenantId: 'tenant-platform', userId: 'user-root' }),
    ])

    const access = await loadCredentialsAccess(client, 'user-root', 'tenant-platform')

    expect(access?.roles).toEqual(['PLATFORM_ADMIN', 'TENANT_ADMIN'])
    expect(access?.permissions).toEqual(Object.values(PERMISSIONS))
  })

  it('answers null for a missing or inactive user and for a missing or inactive membership', async () => {
    const { client } = fakeDatabase({ 'user-alice': { active: true }, 'user-gone': { active: false } }, [
      membershipOf([SYSTEM.TENANT_ADMIN]),
      membershipOf([SYSTEM.TENANT_ADMIN], { id: 'membership-old', tenantId: 'tenant-old', active: false }),
      membershipOf([SYSTEM.TENANT_ADMIN], { id: 'membership-gone', userId: 'user-gone' }),
    ])

    await expect(loadCredentialsAccess(client, 'user-unknown', 'tenant-acme')).resolves.toBeNull()
    await expect(loadCredentialsAccess(client, 'user-gone', 'tenant-acme')).resolves.toBeNull()
    await expect(loadCredentialsAccess(client, 'user-alice', 'tenant-old')).resolves.toBeNull()
    await expect(loadCredentialsAccess(client, 'user-alice', 'tenant-other')).resolves.toBeNull()
  })

  it('a user without a tenant keeps no role and no permission while the user is active', async () => {
    const { client, findMembership } = fakeDatabase({ 'user-alice': { active: true }, 'user-gone': { active: false } }, [])

    await expect(loadCredentialsAccess(client, 'user-alice', null)).resolves.toEqual({ membershipId: null, roles: [], permissions: [] })
    await expect(loadCredentialsAccess(client, 'user-gone', null)).resolves.toBeNull()
    expect(findMembership).not.toHaveBeenCalled()
  })
})

describe('refreshCredentialsToken', () => {
  it('a Credentials token older than 60 s is re-read, and an inactive membership ends the session', async () => {
    const memberships = [membershipOf([SYSTEM.TENANT_ADMIN, SYSTEM.TENANT_EDITOR])]
    const { client, findUser } = fakeDatabase({ 'user-alice': { active: true } }, memberships)
    const loadAccess = (userId: string, tenantId: string | null) => loadCredentialsAccess(client, userId, tenantId)
    const token = tokenOf()

    expect(CREDENTIALS_RECHECK_SECONDS).toBe(60)
    await expect(refreshCredentialsToken(token, { now: SIGNED_IN_AT + 60, loadAccess })).resolves.toBe(token)
    expect(findUser).not.toHaveBeenCalled()

    const reread = await refreshCredentialsToken(token, { now: SIGNED_IN_AT + 61, loadAccess })
    expect(findUser).toHaveBeenCalledTimes(1)
    expect(reread).toEqual({ ...token, checkedAt: SIGNED_IN_AT + 61 })

    memberships[0].active = false
    await expect(refreshCredentialsToken(reread!, { now: SIGNED_IN_AT + 90, loadAccess })).resolves.toBe(reread)
    await expect(refreshCredentialsToken(reread!, { now: SIGNED_IN_AT + 122, loadAccess })).resolves.toBeNull()
  })

  it('an inactive user ends the session at the next re-read', async () => {
    const users = { 'user-alice': { active: true } }
    const { client } = fakeDatabase(users, [membershipOf([SYSTEM.TENANT_ADMIN])])
    const loadAccess = (userId: string, tenantId: string | null) => loadCredentialsAccess(client, userId, tenantId)

    users['user-alice'].active = false

    await expect(refreshCredentialsToken(tokenOf(), { now: SIGNED_IN_AT + 61, loadAccess })).resolves.toBeNull()
  })

  it('a role removed from the membership is gone from the session after the next re-read', async () => {
    const memberships = [membershipOf([SYSTEM.TENANT_ADMIN, SYSTEM.TENANT_EDITOR])]
    const { client } = fakeDatabase({ 'user-alice': { active: true } }, memberships)
    const loadAccess = (userId: string, tenantId: string | null) => loadCredentialsAccess(client, userId, tenantId)
    const token = tokenOf()

    memberships[0].roles = [SYSTEM.TENANT_EDITOR]

    const before = await refreshCredentialsToken(token, { now: SIGNED_IN_AT + 30, loadAccess })
    expect(before?.roles).toEqual(['TENANT_ADMIN', 'TENANT_EDITOR'])

    const after = await refreshCredentialsToken(token, { now: SIGNED_IN_AT + 61, loadAccess })
    expect(after).toEqual({
      ...token,
      checkedAt: SIGNED_IN_AT + 61,
      roles: ['TENANT_EDITOR'],
      permissions: [...ROLE_PERMISSIONS.TENANT_EDITOR],
    })
  })

  it('a requested tenant the user belongs to switches the session at once, and any other tenant is ignored', async () => {
    const { client } = fakeDatabase({ 'user-alice': { active: true } }, [
      membershipOf([SYSTEM.TENANT_ADMIN]),
      membershipOf([SYSTEM.TENANT_VIEWER], { id: 'membership-globex', tenantId: 'tenant-globex' }),
      membershipOf([SYSTEM.TENANT_ADMIN], { id: 'membership-initech', tenantId: 'tenant-initech', active: false }),
    ])
    const loadAccess = (userId: string, tenantId: string | null) => loadCredentialsAccess(client, userId, tenantId)
    const token = tokenOf({ roles: ['TENANT_ADMIN'] })

    await expect(refreshCredentialsToken(token, { now: SIGNED_IN_AT + 5, requestedTenantId: 'tenant-globex', loadAccess }))
      .resolves.toEqual({
        ...token,
        checkedAt: SIGNED_IN_AT + 5,
        currentTenantId: 'tenant-globex',
        membershipId: 'membership-globex',
        roles: ['TENANT_VIEWER'],
        permissions: [...ROLE_PERMISSIONS.TENANT_VIEWER],
      })

    for (const requestedTenantId of ['tenant-initech', 'tenant-unknown']) {
      await expect(refreshCredentialsToken(token, { now: SIGNED_IN_AT + 5, requestedTenantId, loadAccess })).resolves.toBe(token)
    }
  })
})
