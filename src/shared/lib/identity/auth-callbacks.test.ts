import { describe, expect, it, vi } from 'vitest'
import type { DeploymentMode } from '../deployment'
import { LicenseLimitError } from '../errors'
import type { DirectoryUser } from '../keycloak/directory'
import { KeycloakUnavailableError } from '../keycloak/errors'
import { logger } from '../logger'
import { PERMISSIONS, ROLE_PERMISSIONS } from '../permissions'
import { buildAuthCallbacks, type AuthCallbackDeps, type SessionToken } from './auth-callbacks'
import type { KeycloakIdentity } from './keycloak-claims'
import type { SessionDirectory } from './session-recheck'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const ALICE_SUB = '00000000-0000-4000-8000-00000000a11c'
const ALICE_SID = 'b7f1e5a2-0c6d-4f3e-9a51-6f2d8c4e1a90'
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.alice-id-token-payload.alice-id-token-signature'
const REFRESH_TOKEN = 'eyJhbGciOiJIUzUxMiJ9.alice-refresh-token-payload.alice-refresh-token-signature'
// The tokens that a refresh of alice's Keycloak session returns.
const NEW_REFRESH_TOKEN = 'eyJhbGciOiJIUzUxMiJ9.alice-refresh-token-payload-2.alice-refresh-token-signature-2'
const NEW_ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.alice-id-token-payload-2.alice-id-token-signature-2'
const REFRESHED = { refreshToken: NEW_REFRESH_TOKEN, idToken: NEW_ID_TOKEN }
// Auth.js gives every OAuth sign-in a random user id and puts it in token.sub (@auth/core callback.js:216-234).
const AUTH_JS_RANDOM_ID = '6f9c2b1e-4d3a-4e8f-9b7c-1a2d3e4f5a6b'
const PLATFORM_USER_ID = 'cm2platformuseralice0001'
const INSTALL_TENANT = { id: 'tenant-install', name: 'Acme', slug: 'default' }
const NOW_MS = 1_760_000_000_000
const NOW = NOW_MS / 1000

// The ID-token claims of alice in the test realm (tests/fixtures/keycloak/libredb-test-realm.json).
const ALICE_PROFILE = {
  iss: 'http://localhost:58080/realms/libredb',
  aud: 'libredb-platform',
  sub: ALICE_SUB,
  sid: ALICE_SID,
  email: 'alice@libredb.test',
  email_verified: true,
  name: 'Alice Admin',
  preferred_username: 'alice',
  libredb_roles: ['admin'],
}

const KEYCLOAK_ACCOUNT = {
  provider: 'keycloak',
  type: 'oidc',
  providerAccountId: ALICE_SUB,
  id_token: ID_TOKEN,
  access_token: 'alice-access-token',
  refresh_token: REFRESH_TOKEN,
  token_type: 'bearer',
}

// The account of a Credentials sign-in, shaped as @auth/core makes it after authorize.
const CREDENTIALS_ACCOUNT = { provider: 'credentials', type: 'credentials', providerAccountId: 'user-bob' }

// A copy of the claims without the named claims, as an ID token that never carried them.
function without(claims: Record<string, unknown>, ...names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(claims).filter(([name]) => !names.includes(name)))
}

const ALICE_IN_KEYCLOAK: DirectoryUser = {
  id: ALICE_SUB,
  username: 'alice',
  email: 'alice@libredb.test',
  firstName: 'Alice',
  lastName: 'Admin',
  enabled: true,
}

// The Keycloak directory as a session recheck reads it: alice exists, is enabled, holds admin and keeps ALICE_SID.
// A test changes what a read answers with mockResolvedValue or mockRejectedValue.
function fakeDirectory() {
  return {
    getUser: vi.fn<SessionDirectory['getUser']>(async id => (id === ALICE_SUB ? ALICE_IN_KEYCLOAK : null)),
    getEffectiveRoles: vi.fn<SessionDirectory['getEffectiveRoles']>(async () => ['admin']),
    getUserSessionIds: vi.fn<SessionDirectory['getUserSessionIds']>(async () => [ALICE_SID]),
  }
}

function depsOf(overrides: Partial<AuthCallbackDeps> = {}) {
  const provisionKeycloakUser = vi.fn(async (identity: KeycloakIdentity) => ({
    id: PLATFORM_USER_ID,
    email: identity.email,
    name: identity.name,
  }))
  const directory = fakeDirectory()
  // Keycloak refreshes alice's session and returns the tokens REFRESHED.
  const refreshKeycloakSession = vi.fn<AuthCallbackDeps['refreshKeycloakSession']>(async () => REFRESHED)
  // The license admits every admin, as it does one with a Platform user; a test refuses one with mockRejectedValue.
  const admitKeycloakAdmin = vi.fn<AuthCallbackDeps['admitKeycloakAdmin']>(async () => {})
  const deps: AuthCallbackDeps = {
    deploymentMode: 'self-hosted',
    roleClaim: 'libredb_roles',
    adminRole: 'admin',
    admitKeycloakAdmin,
    provisionKeycloakUser,
    getInstallTenant: vi.fn(async () => INSTALL_TENANT),
    loadCredentialsAccess: vi.fn(async () => null),
    readTenantCookie: vi.fn(async () => undefined),
    keycloakDirectory: () => directory,
    refreshKeycloakSession,
    // The defaults of PLATFORM_SESSION_RECHECK_SECONDS and PLATFORM_RECHECK_GRACE_SECONDS.
    sessionRecheck: { intervalSeconds: 300, graceSeconds: 900 },
    now: () => NOW_MS,
    ...overrides,
  }
  return { deps, provisionKeycloakUser, directory, refreshKeycloakSession, admitKeycloakAdmin }
}

// A clock that a test moves forward, in seconds since the epoch.
function clockAt(seconds: number) {
  const clock = { seconds, now: () => clock.seconds * 1000 }
  return clock
}

// The jwt call of a Keycloak sign-in, shaped as @auth/core makes it.
function keycloakSignIn(profile: Record<string, unknown> = ALICE_PROFILE) {
  return {
    token: { name: 'Alice Admin', email: 'alice@libredb.test', picture: undefined, sub: AUTH_JS_RANDOM_ID },
    user: { id: AUTH_JS_RANDOM_ID, name: 'Alice Admin', email: 'alice@libredb.test', image: undefined },
    account: KEYCLOAK_ACCOUNT,
    profile,
    trigger: 'signIn' as const,
    isNewUser: false,
  }
}

const EXPIRES = '2026-10-23T08:00:00.000Z'

// The session that @auth/core hands the session callback: the name, email and picture of the token, and the expiry.
function defaultSessionOf(token: { name?: string | null; email?: string | null; picture?: string | null }) {
  return { user: { name: token.name, email: token.email, image: token.picture }, expires: EXPIRES }
}

function credentialsToken(overrides: Partial<SessionToken> = {}): SessionToken {
  return {
    name: 'Bob User',
    email: 'bob@example.com',
    sub: 'user-bob',
    id: 'user-bob',
    authProvider: 'credentials',
    checkedAt: NOW,
    currentTenantId: 'tenant-acme',
    membershipId: 'membership-acme',
    roles: ['TENANT_EDITOR'],
    permissions: [...ROLE_PERMISSIONS.TENANT_EDITOR],
    accessibleTenants: [
      { id: 'tenant-acme', name: 'Acme', slug: 'acme' },
      { id: 'tenant-globex', name: 'Globex', slug: 'globex' },
    ],
    ...overrides,
  }
}

describe('signIn', () => {
  it('signIn returns false without the admin role', async () => {
    const { signIn } = buildAuthCallbacks(depsOf().deps)
    const noRole = without(ALICE_PROFILE, 'libredb_roles')

    for (const profile of [{ ...ALICE_PROFILE, libredb_roles: ['user'] }, noRole, { ...ALICE_PROFILE, libredb_roles: ['Admin', 'administrator'] }]) {
      await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile })).resolves.toBe(false)
    }
  })

  it('signIn admits a Keycloak account with the admin role and leaves Credentials sign-ins to authorize', async () => {
    const { signIn } = buildAuthCallbacks(depsOf().deps)
    const { signIn: cloudSignIn } = buildAuthCallbacks(depsOf({ deploymentMode: 'cloud' }).deps)

    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: { ...ALICE_PROFILE, libredb_roles: ['user', 'admin'] } }))
      .resolves.toBe(true)
    await expect(cloudSignIn({ user: { id: 'user-bob' }, account: CREDENTIALS_ACCOUNT })).resolves.toBe(true)
  })

  it('signIn refuses a Credentials sign-in in self-hosted mode', async () => {
    const { ConfigError } = await import('../errors')
    const { signIn } = buildAuthCallbacks(depsOf({ deploymentMode: 'self-hosted' }).deps)

    await expect(signIn({ user: { id: 'user-bob' }, account: CREDENTIALS_ACCOUNT })).rejects.toThrow(ConfigError)
  })

  it('signIn reads the claim and the role that the configuration names', async () => {
    const { signIn } = buildAuthCallbacks(depsOf({ roleClaim: 'platform_roles', adminRole: 'dba' }).deps)

    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: { ...ALICE_PROFILE, platform_roles: ['dba'] } })).resolves.toBe(true)
    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: ALICE_PROFILE })).resolves.toBe(false)
  })

  it('signIn returns /login?error=IdentityClaimMissing without an email', async () => {
    const { signIn } = buildAuthCallbacks(depsOf().deps)
    const withoutEmail = without(ALICE_PROFILE, 'email')

    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: withoutEmail })).resolves.toBe('/login?error=IdentityClaimMissing')
    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: { ...ALICE_PROFILE, email: '' } }))
      .resolves.toBe('/login?error=IdentityClaimMissing')
  })

  it('signIn returns /login?error=IdentityClaimMissing for a role claim that is not a list of role names', async () => {
    const { signIn } = buildAuthCallbacks(depsOf().deps)

    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: { ...ALICE_PROFILE, libredb_roles: 'admin' } }))
      .resolves.toBe('/login?error=IdentityClaimMissing')
  })

  it('signIn refuses a Keycloak account outside self-hosted mode with ConfigError', async () => {
    const { ConfigError } = await import('../errors')
    const { signIn } = buildAuthCallbacks(depsOf({ deploymentMode: 'cloud' }).deps)

    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: ALICE_PROFILE })).rejects.toThrow(ConfigError)
  })

  it('signIn refuses a provider that Platform does not know', async () => {
    const { signIn } = buildAuthCallbacks(depsOf().deps)

    await expect(signIn({ user: {}, account: { ...KEYCLOAK_ACCOUNT, provider: 'github' }, profile: ALICE_PROFILE })).resolves.toBe(false)
    await expect(signIn({ user: {}, account: null })).resolves.toBe(false)
  })

  it('signIn asks the license to admit a Keycloak account with the admin role, and admits it when the license does', async () => {
    const { deps, admitKeycloakAdmin } = depsOf()
    const { signIn } = buildAuthCallbacks(deps)

    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: ALICE_PROFILE })).resolves.toBe(true)
    expect(admitKeycloakAdmin).toHaveBeenCalledExactlyOnceWith({
      sub: ALICE_SUB,
      sid: ALICE_SID,
      email: 'alice@libredb.test',
      name: 'Alice Admin',
      username: 'alice',
      roles: ['admin'],
    })
  })

  it('signIn sends a first sign-in that the license refuses to the login page with the code of the refusal instead of AccessDenied', async () => {
    for (const code of ['LICENSE_ADMIN_SEATS', 'LICENSE_EXPIRED', 'LICENSE_INVALID'] as const) {
      const { deps, admitKeycloakAdmin } = depsOf()
      admitKeycloakAdmin.mockRejectedValue(new LicenseLimitError(code))
      const { signIn } = buildAuthCallbacks(deps)

      await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: ALICE_PROFILE }), code).resolves.toBe(
        `/login?error=${code}`,
      )
      expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('license'), { keycloakId: ALICE_SUB, code })
    }
  })

  it('signIn never asks the license about an account that it refuses for its role or its claims', async () => {
    const { deps, admitKeycloakAdmin } = depsOf()
    const { signIn } = buildAuthCallbacks(deps)

    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: { ...ALICE_PROFILE, libredb_roles: ['user'] } })).resolves.toBe(false)
    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: without(ALICE_PROFILE, 'email') })).resolves.toBe(
      '/login?error=IdentityClaimMissing',
    )
    expect(admitKeycloakAdmin).not.toHaveBeenCalled()
  })

  it('signIn sends a first sign-in whose admin seats could not be checked to the login page with AdminSeatCheckFailed instead of AccessDenied', async () => {
    // Auth.js answers an error thrown by signIn with AccessDenied, which the login page explains as a missing admin role.
    const unreachable = new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} answered 503')
    const { deps, admitKeycloakAdmin } = depsOf()
    admitKeycloakAdmin.mockRejectedValue(unreachable)
    const { signIn } = buildAuthCallbacks(deps)

    await expect(signIn({ user: {}, account: KEYCLOAK_ACCOUNT, profile: ALICE_PROFILE })).resolves.toBe(
      '/login?error=AdminSeatCheckFailed',
    )
    expect(logger.error).toHaveBeenLastCalledWith(expect.any(String), unreachable, { keycloakId: ALICE_SUB })
  })

  it('signIn takes no admin seat for a sign-in without the ID token or the refresh token, which jwt then fails before it writes anything', async () => {
    const { ConfigError } = await import('../errors')
    const sessionless = [
      { account: { ...KEYCLOAK_ACCOUNT, id_token: undefined }, error: /no ID token/ },
      // A client without refresh tokens could never keep its Keycloak session alive.
      { account: { ...KEYCLOAK_ACCOUNT, refresh_token: undefined }, error: ConfigError },
    ]
    for (const { account, error } of sessionless) {
      const { deps, admitKeycloakAdmin, provisionKeycloakUser } = depsOf()
      const { signIn, jwt } = buildAuthCallbacks(deps)

      // The admission would create the Platform user and take an admin seat for a sign-in that cannot succeed.
      await expect(signIn({ user: {}, account, profile: ALICE_PROFILE })).resolves.toBe(true)
      expect(admitKeycloakAdmin).not.toHaveBeenCalled()
      await expect(jwt({ ...keycloakSignIn(), account })).rejects.toThrow(error)
      expect(deps.getInstallTenant).not.toHaveBeenCalled()
      expect(provisionKeycloakUser).not.toHaveBeenCalled()
    }
  })
})

describe('jwt', () => {
  it('jwt sets token.id and token.sub to users.id', async () => {
    const { deps, provisionKeycloakUser } = depsOf()
    const { jwt } = buildAuthCallbacks(deps)

    const token = await jwt(keycloakSignIn())

    expect(token?.id).toBe(PLATFORM_USER_ID)
    expect(token?.sub).toBe(PLATFORM_USER_ID)
    expect(token?.keycloakId).toBe(ALICE_SUB)
    expect(provisionKeycloakUser).toHaveBeenCalledWith({
      sub: ALICE_SUB,
      sid: ALICE_SID,
      email: 'alice@libredb.test',
      name: 'Alice Admin',
      username: 'alice',
      roles: ['admin'],
    })
  })

  it('jwt keeps idToken and sid in the token', async () => {
    const { jwt } = buildAuthCallbacks(depsOf().deps)

    const token = await jwt(keycloakSignIn())

    expect(token).toMatchObject({ authProvider: 'keycloak', idToken: ID_TOKEN, sid: ALICE_SID, checkedAt: NOW })
  })

  it('a Keycloak sign-in counts as a successful check of the session', async () => {
    const { deps, directory } = depsOf()
    const { jwt } = buildAuthCallbacks(deps)

    const token = await jwt(keycloakSignIn())

    expect(token).toMatchObject({ checkedAt: NOW, recheckAttemptedAt: NOW, directoryDegraded: false })
    expect(directory.getUser).not.toHaveBeenCalled()
  })

  it('jwt refuses a Keycloak sign-in that signIn refuses or without the ID token, and a provider it does not know', async () => {
    const { ConfigError } = await import('../errors')
    const { deps, provisionKeycloakUser } = depsOf()
    const { jwt } = buildAuthCallbacks(deps)
    const userOnly = keycloakSignIn({ ...ALICE_PROFILE, libredb_roles: ['user'] })

    await expect(jwt(userOnly)).rejects.toThrow(/signIn refuses/)
    await expect(buildAuthCallbacks({ ...deps, deploymentMode: 'cloud' }).jwt(keycloakSignIn())).rejects.toThrow(/signIn refuses/)
    await expect(jwt({ ...keycloakSignIn(), account: { ...KEYCLOAK_ACCOUNT, id_token: undefined } })).rejects.toThrow(/no ID token/)
    // A client without refresh tokens could never keep its Keycloak session alive.
    await expect(jwt({ ...keycloakSignIn(), account: { ...KEYCLOAK_ACCOUNT, refresh_token: undefined } })).rejects.toThrow(ConfigError)
    await expect(jwt({ ...keycloakSignIn(), account: { ...KEYCLOAK_ACCOUNT, refresh_token: undefined } })).rejects.toThrow(/refresh token/)
    await expect(jwt({ ...keycloakSignIn(), account: { ...KEYCLOAK_ACCOUNT, provider: 'github' } })).rejects.toThrow(/github/)
    expect(provisionKeycloakUser).not.toHaveBeenCalled()
  })

  it('a Keycloak sign-in fails without writing the user when the install does not have exactly one tenant', async () => {
    const { ConfigError } = await import('../errors')
    const { deps, provisionKeycloakUser } = depsOf({
      getInstallTenant: async () => {
        throw new ConfigError('a self-hosted install needs exactly one tenant, and the database holds none')
      },
    })
    const { jwt } = buildAuthCallbacks(deps)

    await expect(jwt(keycloakSignIn())).rejects.toThrow(ConfigError)
    expect(provisionKeycloakUser).not.toHaveBeenCalled()
  })

  it('jwt keeps a Keycloak token unchanged on later requests until a recheck is due', async () => {
    const clock = clockAt(NOW)
    const { deps, provisionKeycloakUser, directory } = depsOf({ now: clock.now })
    const { jwt } = buildAuthCallbacks(deps)
    const token = await jwt(keycloakSignIn())

    await expect(jwt({ token: token! })).resolves.toBe(token)
    clock.seconds = NOW + 299
    await expect(jwt({ token: token! })).resolves.toBe(token)
    expect(provisionKeycloakUser).toHaveBeenCalledTimes(1)
    expect(directory.getUser).not.toHaveBeenCalled()
  })

  it('jwt returns null on a revoked verdict and refreshes checkedAt on a valid one', async () => {
    const clock = clockAt(NOW)
    const { deps, directory } = depsOf({ now: clock.now })
    const { jwt } = buildAuthCallbacks(deps)
    const signedIn = await jwt(keycloakSignIn())

    clock.seconds = NOW + 300
    const rechecked = await jwt({ token: signedIn! })
    expect(rechecked).toEqual({
      ...signedIn,
      ...REFRESHED,
      checkedAt: NOW + 300,
      recheckAttemptedAt: NOW + 300,
      directoryDegraded: false,
    })
    expect(directory.getUser).toHaveBeenCalledWith(ALICE_SUB)

    // The admin role is removed in Keycloak.
    directory.getEffectiveRoles.mockResolvedValue(['user'])
    clock.seconds = NOW + 600
    await expect(jwt({ token: rechecked! })).resolves.toBeNull()
  })

  it('a Keycloak token is never returned unchanged once a recheck is due, and a revoked verdict ends it', async () => {
    const clock = clockAt(NOW)
    const signedIn = await buildAuthCallbacks(depsOf({ now: clock.now }).deps).jwt(keycloakSignIn())
    clock.seconds = NOW + 300

    // Keycloak still backs the session: the token comes back with the new check.
    const valid = depsOf({ now: clock.now })
    const rechecked = await buildAuthCallbacks(valid.deps).jwt({ token: signedIn! })
    expect(rechecked).not.toBe(signedIn)
    expect(rechecked).toMatchObject({ checkedAt: NOW + 300, recheckAttemptedAt: NOW + 300, directoryDegraded: false })

    // Keycloak cannot be reached: the token comes back degraded, with its last success unchanged.
    const unreachable = depsOf({ now: clock.now })
    unreachable.directory.getUser.mockRejectedValue(new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} answered 503'))
    const degraded = await buildAuthCallbacks(unreachable.deps).jwt({ token: signedIn! })
    expect(degraded).not.toBe(signedIn)
    expect(degraded).toMatchObject({ checkedAt: NOW, recheckAttemptedAt: NOW + 300, directoryDegraded: true })

    // Each revocation ends the session: alice deleted, disabled, without the admin role, or with her Keycloak session ended.
    const revocations: Array<(directory: ReturnType<typeof fakeDirectory>) => void> = [
      directory => directory.getUser.mockResolvedValue(null),
      directory => directory.getUser.mockResolvedValue({ ...ALICE_IN_KEYCLOAK, enabled: false }),
      directory => directory.getEffectiveRoles.mockResolvedValue([]),
      directory => directory.getUserSessionIds.mockResolvedValue([]),
    ]
    for (const revoke of revocations) {
      const { deps, directory } = depsOf({ now: clock.now })
      revoke(directory)
      await expect(buildAuthCallbacks(deps).jwt({ token: signedIn! })).resolves.toBeNull()
    }
  })

  it('a Credentials sign-in carries checkedAt and the access that authorize returned', async () => {
    const { jwt } = buildAuthCallbacks(depsOf({ deploymentMode: 'cloud' }).deps)
    const expected = credentialsToken()
    const user = {
      id: 'user-bob',
      email: 'bob@example.com',
      name: 'Bob User',
      currentTenantId: expected.currentTenantId,
      membershipId: expected.membershipId,
      roles: expected.roles,
      permissions: expected.permissions,
      accessibleTenants: expected.accessibleTenants,
    }

    const token = await jwt({
      token: { name: 'Bob User', email: 'bob@example.com', picture: undefined, sub: 'user-bob' },
      user,
      account: { provider: 'credentials', type: 'credentials', providerAccountId: 'user-bob' },
      trigger: 'signIn',
    })

    expect(token).toEqual({ ...expected, picture: undefined })
  })

  it('a Credentials token is re-read after 60 s and ends with its membership', async () => {
    const loadCredentialsAccess = vi.fn(async () => null)
    const { jwt } = buildAuthCallbacks(depsOf({ deploymentMode: 'cloud', loadCredentialsAccess, now: () => (NOW + 61) * 1000 }).deps)

    await expect(jwt({ token: credentialsToken() })).resolves.toBeNull()
    expect(loadCredentialsAccess).toHaveBeenCalledWith('user-bob', 'tenant-acme')
  })

  it('a token without the Platform session fields ends the session', async () => {
    const { jwt } = buildAuthCallbacks(depsOf({ deploymentMode: 'cloud' }).deps)

    // A token that the callbacks of an earlier release wrote, without authProvider and checkedAt.
    const legacy = without(credentialsToken(), 'authProvider', 'checkedAt')
    await expect(jwt({ token: legacy })).resolves.toBeNull()
    await expect(jwt({ token: { ...credentialsToken(), authProvider: 'github' } as never })).resolves.toBeNull()
  })

  it('a Keycloak token without the fields of the session recheck ends the session', async () => {
    const { deps, directory } = depsOf()
    const { jwt, session } = buildAuthCallbacks(deps)
    const token = await jwt(keycloakSignIn())

    // A Keycloak token signed in before the recheck or the session refresh existed, and tokens that lost what they read.
    for (const name of ['recheckAttemptedAt', 'directoryDegraded', 'keycloakId', 'sid', 'refreshToken', 'idToken']) {
      const incomplete = without(token!, name)
      await expect(jwt({ token: incomplete })).resolves.toBeNull()
      await expect(session({ session: defaultSessionOf(token!), token: incomplete })).rejects.toThrow(/session fields/)
    }
    await expect(jwt({ token: { ...token!, keycloakId: '' } })).resolves.toBeNull()
    await expect(jwt({ token: { ...token!, refreshToken: '' } })).resolves.toBeNull()
    expect(directory.getUser).not.toHaveBeenCalled()
  })

  it('in cloud mode the libredb-current-tenant cookie switches a Credentials session to a tenant of the user', async () => {
    const loadCredentialsAccess = vi.fn(async (_userId: string, tenantId: string | null) =>
      tenantId === 'tenant-globex'
        ? { membershipId: 'membership-globex', roles: ['TENANT_VIEWER'], permissions: [...ROLE_PERMISSIONS.TENANT_VIEWER] }
        : null)
    const { jwt } = buildAuthCallbacks(depsOf({
      deploymentMode: 'cloud',
      loadCredentialsAccess,
      readTenantCookie: async () => 'tenant-globex',
    }).deps)

    const token = await jwt({ token: credentialsToken() })

    expect(token).toMatchObject({ currentTenantId: 'tenant-globex', membershipId: 'membership-globex', roles: ['TENANT_VIEWER'] })
  })

  it("in self-hosted mode the libredb-current-tenant cookie never changes the session's tenant", async () => {
    const readTenantCookie = vi.fn(async () => 'tenant-globex')
    const loadCredentialsAccess = vi.fn(async () => ({
      membershipId: 'membership-globex',
      roles: ['TENANT_ADMIN'],
      permissions: [...ROLE_PERMISSIONS.TENANT_ADMIN],
    }))
    const { deps } = depsOf({ deploymentMode: 'self-hosted' satisfies DeploymentMode, readTenantCookie, loadCredentialsAccess })
    const { jwt } = buildAuthCallbacks(deps)

    const keycloak = await jwt(keycloakSignIn())
    await expect(jwt({ token: keycloak! })).resolves.toMatchObject({ currentTenantId: INSTALL_TENANT.id, roles: ['PLATFORM_ADMIN'] })

    await expect(jwt({ token: credentialsToken() })).resolves.toBeNull()

    expect(readTenantCookie).not.toHaveBeenCalled()
    expect(loadCredentialsAccess).not.toHaveBeenCalled()
  })

  it('in self-hosted mode an existing Credentials token ends its session on its next request', async () => {
    const loadCredentialsAccess = vi.fn(async () => ({
      membershipId: 'membership-acme',
      roles: ['TENANT_EDITOR'],
      permissions: [...ROLE_PERMISSIONS.TENANT_EDITOR],
    }))
    const { jwt } = buildAuthCallbacks(depsOf({ deploymentMode: 'self-hosted', loadCredentialsAccess }).deps)

    // Self-hosted mode refuses a password sign-in, so such a token was signed elsewhere with the same AUTH_SECRET, and no
    // Keycloak recheck would ever end it: it ends before and after its 60 s re-read is due, whatever its membership says.
    await expect(jwt({ token: credentialsToken() })).resolves.toBeNull()
    await expect(jwt({ token: credentialsToken({ checkedAt: NOW - 61 }) })).resolves.toBeNull()
    expect(loadCredentialsAccess).not.toHaveBeenCalled()
  })
})

describe('session', () => {
  it('session never exposes idToken, sid or keycloakId', async () => {
    const { jwt, session } = buildAuthCallbacks(depsOf().deps)
    const token = await jwt(keycloakSignIn())

    const payload = await session({ session: defaultSessionOf(token!), token: token! })
    const serialized = JSON.stringify(payload)

    for (const secret of [ID_TOKEN, ALICE_SID, ALICE_SUB, 'idToken', 'keycloakId', '"sid"', 'checkedAt', 'recheckAttemptedAt']) {
      expect(serialized).not.toContain(secret)
    }
    expect(payload.authProvider).toBe('keycloak')
    expect(payload.user).toEqual({ id: PLATFORM_USER_ID, name: 'Alice Admin', email: 'alice@libredb.test', image: undefined })
  })

  it('the refresh token stays in the JWT and never reaches the session payload', async () => {
    const clock = clockAt(NOW)
    const { deps, refreshKeycloakSession } = depsOf({ now: clock.now })
    const { jwt, session } = buildAuthCallbacks(deps)

    // The sign-in keeps the refresh token of the account beside the ID token, encrypted in the JWT.
    const signedIn = await jwt(keycloakSignIn())
    expect(signedIn).toMatchObject({ refreshToken: REFRESH_TOKEN, idToken: ID_TOKEN })
    expect(refreshKeycloakSession).not.toHaveBeenCalled()

    // A due recheck spends it on Keycloak and keeps the new tokens in the JWT.
    clock.seconds = NOW + 300
    const rechecked = await jwt({ token: signedIn! })
    expect(refreshKeycloakSession).toHaveBeenCalledExactlyOnceWith(REFRESH_TOKEN)
    expect(rechecked).toMatchObject({ refreshToken: NEW_REFRESH_TOKEN, idToken: NEW_ID_TOKEN })

    for (const token of [signedIn!, rechecked!]) {
      const serialized = JSON.stringify(await session({ session: defaultSessionOf(token), token }))
      for (const secret of [REFRESH_TOKEN, NEW_REFRESH_TOKEN, ID_TOKEN, NEW_ID_TOKEN, 'refreshToken', 'idToken']) {
        expect(serialized).not.toContain(secret)
      }
    }
  })

  it('a self-hosted session has the role PLATFORM_ADMIN, every permission and the install tenant', async () => {
    const { jwt, session } = buildAuthCallbacks(depsOf().deps)
    const token = await jwt(keycloakSignIn())

    const payload = await session({ session: defaultSessionOf(token!), token: token! })

    expect(payload).toEqual({
      user: { id: PLATFORM_USER_ID, name: 'Alice Admin', email: 'alice@libredb.test', image: undefined },
      expires: EXPIRES,
      authProvider: 'keycloak',
      roles: ['PLATFORM_ADMIN'],
      permissions: Object.values(PERMISSIONS),
      currentTenantId: INSTALL_TENANT.id,
      membershipId: null,
      accessibleTenants: [INSTALL_TENANT],
      directoryDegraded: false,
    })
  })

  it('the session payload carries directoryDegraded while the recheck cannot read the directory', async () => {
    const clock = clockAt(NOW)
    const { deps, directory } = depsOf({ now: clock.now })
    const { jwt, session } = buildAuthCallbacks(deps)
    const signedIn = await jwt(keycloakSignIn())

    directory.getUser.mockRejectedValue(new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} could not be reached'))
    clock.seconds = NOW + 300
    const degraded = await jwt({ token: signedIn! })
    await expect(session({ session: defaultSessionOf(degraded!), token: degraded! })).resolves.toMatchObject({ directoryDegraded: true })

    directory.getUser.mockResolvedValue(ALICE_IN_KEYCLOAK)
    clock.seconds = NOW + 600
    const recovered = await jwt({ token: degraded! })
    await expect(session({ session: defaultSessionOf(recovered!), token: recovered! })).resolves.toMatchObject({ directoryDegraded: false })
  })

  it('a Credentials session carries its membership and authProvider', async () => {
    const { session } = buildAuthCallbacks(depsOf({ deploymentMode: 'cloud' }).deps)
    const token = credentialsToken()

    await expect(session({ session: defaultSessionOf(token), token })).resolves.toEqual({
      user: { id: 'user-bob', name: 'Bob User', email: 'bob@example.com', image: undefined },
      expires: EXPIRES,
      authProvider: 'credentials',
      roles: token.roles,
      permissions: token.permissions,
      currentTenantId: token.currentTenantId,
      membershipId: token.membershipId,
      accessibleTenants: token.accessibleTenants,
      // A Credentials session reads no directory.
      directoryDegraded: false,
    })
  })
})
