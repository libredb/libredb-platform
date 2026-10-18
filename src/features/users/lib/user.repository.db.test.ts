import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { createFreshDatabase } from '../../../../tests/db/fresh-database'
import { fakeAdminDirectory } from '../../../../tests/license/admin-directory'
import { SMALL_LICENSE_ACTIVE } from '../../../../tests/license/statuses'

// A self-hosted install starts from an empty database, so this file reads one of its own that no other test writes to.
const DATABASE = 'libredb_self_hosted_users'

describe('UserRepository.findAll on a self-hosted install', () => {
  let db: typeof import('@/shared/lib/db').db
  let UserRepository: typeof import('./user.repository').UserRepository
  let superuser: Client

  beforeAll(async () => {
    await createFreshDatabase(DATABASE)
    // The runtime role, as Platform connects; the seed's and the shared Prisma clients read DATABASE_URL when they load.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform', DATABASE)}?schema=platform`)
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
    vi.stubEnv('PLATFORM_ORGANIZATION_NAME', 'Acme Corporation')
    ;({ db } = await import('@/shared/lib/db'))
    ;({ UserRepository } = await import('./user.repository'))
    superuser = await connectSuperuser(DATABASE)
    const { seedProduction } = await import('../../../../prisma/seeds/production')
    await seedProduction()
  })

  afterAll(async () => {
    await superuser.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('lists none of the admins, because a Keycloak sign-in writes a users row and no tenant membership', async () => {
    const { buildAuthCallbacks } = await import('@/shared/lib/identity/auth-callbacks')
    const { admitKeycloakAdmin, provisionKeycloakUser } = await import('@/shared/lib/identity/keycloak-provisioning')
    const { getInstallTenant } = await import('@/shared/lib/identity/install-tenant')
    // The first admin takes the one admin seat of the install's license.
    const admission = {
      getLicenseStatus: () => SMALL_LICENSE_ACTIVE,
      getInstallTenant,
      directory: () => fakeAdminDirectory({ 'kc-alice': { enabled: true, roles: ['admin'] } }),
      adminRole: 'admin',
    }
    // The callbacks as src/shared/lib/auth.ts wires them; a first sign-in neither rechecks nor refreshes its session.
    const { signIn, jwt } = buildAuthCallbacks({
      deploymentMode: 'self-hosted',
      roleClaim: 'libredb_roles',
      adminRole: 'admin',
      admitKeycloakAdmin: (identity) => admitKeycloakAdmin(db, identity, admission),
      provisionKeycloakUser: (identity) => provisionKeycloakUser(db, identity),
      getInstallTenant,
      loadCredentialsAccess: async () => null,
      readTenantCookie: async () => undefined,
      keycloakDirectory: () => {
        throw new Error('A first sign-in reads no session directory')
      },
      refreshKeycloakSession: async () => {
        throw new Error('A first sign-in refreshes no Keycloak session')
      },
      sessionRecheck: { intervalSeconds: 300, graceSeconds: 900 },
      now: () => Date.now(),
    })
    const account = {
      provider: 'keycloak',
      type: 'oidc',
      providerAccountId: 'kc-alice',
      id_token: 'alice-id-token',
      refresh_token: 'alice-refresh-token',
    }
    const profile = { sub: 'kc-alice', email: 'alice@libredb.test', name: 'Alice', libredb_roles: ['admin'] }
    const tenant = await getInstallTenant()

    await expect(signIn({ user: {}, account, profile })).resolves.toBe(true)
    await expect(jwt({ token: {}, account, profile, trigger: 'signIn' })).resolves.toMatchObject({
      roles: ['PLATFORM_ADMIN'],
      currentTenantId: tenant.id,
      membershipId: null,
    })

    const { rows } = await superuser.query(
      `SELECT (SELECT count(*)::int FROM platform.users WHERE "keycloakId" = 'kc-alice') AS users,
              (SELECT count(*)::int FROM platform.tenant_members) AS members`,
    )
    expect(rows).toEqual([{ users: 1, members: 0 }])
    expect(await UserRepository.findAll()).toEqual([])
  })
})
