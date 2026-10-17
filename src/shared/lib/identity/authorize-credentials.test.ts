import bcrypt from 'bcryptjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authorizeCredentials, type CredentialsClient } from './authorize-credentials'

const PASSWORD = 'correct horse battery staple'
// Cost 4 keeps the test fast; the comparison is the same at any cost.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4)

type SeedRole = { code: string; isSystem: boolean; permissions: string[] }

function membership(overrides: { id: string; tenantId: string; isDefault: boolean; roles: SeedRole[] }) {
  return {
    id: overrides.id,
    tenantId: overrides.tenantId,
    isDefault: overrides.isDefault,
    tenant: { id: overrides.tenantId, name: `Tenant ${overrides.tenantId}`, slug: overrides.tenantId },
    roles: overrides.roles.map(role => ({
      role: { code: role.code, isSystem: role.isSystem, permissions: role.permissions.map(code => ({ permission: { code } })) },
    })),
  }
}

function credentialOf(user: { id: string; email: string; active: boolean }) {
  return {
    userId: user.id,
    email: user.email,
    passwordHash: PASSWORD_HASH,
    user: {
      id: user.id,
      email: user.email,
      name: 'Alice Example',
      active: user.active,
      memberships: [
        membership({
          id: 'membership-other',
          tenantId: 'tenant-other',
          isDefault: false,
          roles: [{ code: 'TENANT_VIEWER', isSystem: true, permissions: ['connection.view'] }],
        }),
        membership({
          id: 'membership-default',
          tenantId: 'tenant-default',
          isDefault: true,
          roles: [
            { code: 'TENANT_ADMIN', isSystem: true, permissions: ['connection.view', 'connection.create'] },
            { code: 'TENANT_EDITOR', isSystem: true, permissions: ['connection.view'] },
            // A custom role that took a reserved code before custom roles were refused such codes: the session never
            // carries that code.
            { code: 'PLATFORM_ADMIN', isSystem: false, permissions: [] },
          ],
        }),
      ],
    },
  }
}

// password_credentials keyed by email, the way PostgreSQL compares text: exactly.
function fakeClient(credentials: ReturnType<typeof credentialOf>[]) {
  const byEmail = new Map(credentials.map(credential => [credential.email, credential]))
  const client = {
    passwordCredential: {
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => byEmail.get(where.email) ?? null),
    },
    user: {
      update: vi.fn(async () => ({})),
    },
  }
  return { client, asClient: client as unknown as CredentialsClient }
}

describe('authorizeCredentials', () => {
  let alice: ReturnType<typeof credentialOf>

  beforeEach(() => {
    alice = credentialOf({ id: 'user-alice', email: 'alice@example.com', active: true })
  })

  it('looks up the trimmed, lower-cased email in password_credentials', async () => {
    const { client, asClient } = fakeClient([alice])

    const user = await authorizeCredentials(asClient, { email: '  Alice@Example.COM ', password: PASSWORD })

    expect(client.passwordCredential.findUnique).toHaveBeenCalledTimes(1)
    expect(client.passwordCredential.findUnique.mock.calls[0][0]).toMatchObject({ where: { email: 'alice@example.com' } })
    expect(user?.id).toBe('user-alice')
  })

  it('refuses an inactive user and a wrong password', async () => {
    const inactive = credentialOf({ id: 'user-inactive', email: 'inactive@example.com', active: false })
    const { client, asClient } = fakeClient([alice, inactive])

    await expect(authorizeCredentials(asClient, { email: 'inactive@example.com', password: PASSWORD })).resolves.toBeNull()
    await expect(authorizeCredentials(asClient, { email: 'alice@example.com', password: 'wrong password' })).resolves.toBeNull()
    expect(client.user.update).not.toHaveBeenCalled()
  })

  it('refuses an unknown email and missing credentials', async () => {
    const { client, asClient } = fakeClient([alice])

    await expect(authorizeCredentials(asClient, { email: 'nobody@example.com', password: PASSWORD })).resolves.toBeNull()
    await expect(authorizeCredentials(asClient, { email: 'alice@example.com' })).resolves.toBeNull()
    await expect(authorizeCredentials(asClient, { password: PASSWORD })).resolves.toBeNull()
    await expect(authorizeCredentials(asClient, { email: 42, password: PASSWORD })).resolves.toBeNull()
    expect(client.passwordCredential.findUnique).toHaveBeenCalledTimes(1)
    expect(client.user.update).not.toHaveBeenCalled()
  })

  it('returns the session user of the default membership without reserved codes of custom roles, and records the sign-in', async () => {
    const { client, asClient } = fakeClient([alice])

    const user = await authorizeCredentials(asClient, { email: 'alice@example.com', password: PASSWORD })

    expect(user).toEqual({
      id: 'user-alice',
      email: 'alice@example.com',
      name: 'Alice Example',
      currentTenantId: 'tenant-default',
      membershipId: 'membership-default',
      roles: ['TENANT_ADMIN', 'TENANT_EDITOR'],
      permissions: ['connection.view', 'connection.create'],
      accessibleTenants: [
        { id: 'tenant-other', name: 'Tenant tenant-other', slug: 'tenant-other' },
        { id: 'tenant-default', name: 'Tenant tenant-default', slug: 'tenant-default' },
      ],
    })
    expect(client.user.update).toHaveBeenCalledWith({ where: { id: 'user-alice' }, data: { lastLoginAt: expect.any(Date) } })
  })

  it('a custom role grants no permission under a reserved code and otherwise only permissions that TENANT_ADMIN holds', async () => {
    alice.user.memberships = [
      membership({
        id: 'membership-default',
        tenantId: 'tenant-default',
        isDefault: true,
        roles: [
          { code: 'TENANT_VIEWER', isSystem: true, permissions: ['connection.view'] },
          // Custom roles that took reserved codes before custom roles were refused such codes.
          { code: 'PLATFORM_ADMIN', isSystem: false, permissions: ['platform.dashboard', 'connection.create'] },
          { code: 'TENANT_ADMIN', isSystem: false, permissions: ['user.invite'] },
          { code: 'AUDITOR', isSystem: false, permissions: ['audit.view', 'tenant.manage', 'ticket.view.all'] },
        ],
      }),
    ]
    const { asClient } = fakeClient([alice])

    const user = await authorizeCredentials(asClient, { email: 'alice@example.com', password: PASSWORD })

    expect(user?.roles).toEqual(['TENANT_VIEWER', 'AUDITOR'])
    expect(user?.permissions).toEqual(['connection.view', 'audit.view'])
  })
})
