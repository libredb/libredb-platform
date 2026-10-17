import { describe, expect, it, vi } from 'vitest'
import {
  KEYCLOAK_URL,
  TEST_CLIENTS,
  TEST_REALM,
  codeLogin,
  decodeJwtPayload,
} from '../../../../tests/keycloak/helpers/code-login'
import { createKeycloakAdminClient } from '../keycloak/admin-client'
import { keycloakAdminConfig } from '../keycloak/config'
import { createKeycloakDirectory } from '../keycloak/directory'
import { keycloakSessionRefreshConfig, refreshKeycloakSession } from '../keycloak/token-refresh'
import { logger } from '../logger'
import { buildAuthCallbacks, type AuthCallbackDeps, type SessionToken } from './auth-callbacks'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Runs against the keycloak service of docker-compose.test.yml, whose realm mirrors the one the installer converges:
// the callbacks, with the default PLATFORM_ROLE_CLAIM and PLATFORM_ADMIN_ROLE, read real ID tokens, and
// the session recheck refreshes the Keycloak session and reads the realm as the service account of libredb-platform.
// Two tests shorten the realm's SSO Session Idle for a moment, one of them with Revoke Refresh Token on, and restore
// the realm's settings however they end; vitest runs the integration files one at a time, so no other file sees them.

const ALICE_ID = '00000000-0000-4000-8000-00000000a11c'
const FRANK_ID = '00000000-0000-4000-8000-00000000f4a2'
const CAROL_ID = '00000000-0000-4000-8000-00000000ca20'
const INSTALL_TENANT = { id: 'tenant-install', name: 'Acme', slug: 'default' }

const KEYCLOAK_ENV = {
  AUTH_KEYCLOAK_ISSUER: `${KEYCLOAK_URL}/realms/${TEST_REALM}`,
  AUTH_KEYCLOAK_ID: TEST_CLIENTS.platform.clientId,
  AUTH_KEYCLOAK_SECRET: TEST_CLIENTS.platform.clientSecret,
}
const directory = createKeycloakDirectory(createKeycloakAdminClient(keycloakAdminConfig(KEYCLOAK_ENV)))
const refreshConfig = keycloakSessionRefreshConfig(KEYCLOAK_ENV)

const DEPS: AuthCallbackDeps = {
  deploymentMode: 'self-hosted',
  roleClaim: 'libredb_roles',
  adminRole: 'admin',
  // The license admits every admin here; src/shared/lib/license/admin-seats.integration.test.ts reads this realm the
  // way the admission of a first sign-in does.
  admitKeycloakAdmin: async () => {},
  provisionKeycloakUser: async identity => ({ id: `platform-${identity.username}`, email: identity.email, name: identity.name }),
  getInstallTenant: async () => INSTALL_TENANT,
  loadCredentialsAccess: async () => null,
  readTenantCookie: async () => undefined,
  keycloakDirectory: () => directory,
  refreshKeycloakSession: refreshToken => refreshKeycloakSession(refreshToken, { config: refreshConfig }),
  sessionRecheck: { intervalSeconds: 300, graceSeconds: 900 },
  now: () => Date.now(),
}

// The account and profile that Auth.js hands the callbacks after the code exchange: the account carries the tokens of
// the exchange, and the profile is the ID token's claims.
async function keycloakSignIn(username: string) {
  const tokens = await codeLogin({ username })
  const profile = decodeJwtPayload(tokens.id_token)
  return {
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    account: {
      provider: 'keycloak',
      type: 'oidc',
      providerAccountId: String(profile.sub),
      id_token: tokens.id_token,
      refresh_token: tokens.refresh_token,
    },
    profile,
  }
}

/**
 * Reads or changes the settings of the fixture realm as the master administrator that docker-compose.test.yml
 * bootstraps, because the service account of libredb-platform may only read users and clients.
 */
async function asRealmAdmin(method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
  const token = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' }),
  })
  if (!token.ok) throw new Error(`The Keycloak master administrator could not sign in: HTTP ${token.status}`)
  const { access_token: accessToken } = (await token.json()) as { access_token: string }
  const response = await fetch(`${KEYCLOAK_URL}/admin/realms/${TEST_REALM}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Keycloak Admin REST ${method} /admin/realms/${TEST_REALM} answered HTTP ${response.status}`)
  return response
}

/** The realm's SSO Session Idle, in seconds. */
async function ssoSessionIdle(): Promise<number> {
  const realm = (await (await asRealmAdmin('GET')).json()) as { ssoSessionIdleTimeout?: unknown }
  if (typeof realm.ssoSessionIdleTimeout !== 'number') throw new Error('The fixture realm carries no ssoSessionIdleTimeout')
  return realm.ssoSessionIdleTimeout
}

async function setSsoSessionIdle(seconds: number): Promise<void> {
  await asRealmAdmin('PUT', { ssoSessionIdleTimeout: seconds })
}

/** The realm's Revoke Refresh Token setting and how often it lets one refresh token be reused. */
interface RefreshTokenRevocation {
  revokeRefreshToken: boolean
  refreshTokenMaxReuse: number
}

async function refreshTokenRevocation(): Promise<RefreshTokenRevocation> {
  const realm = (await (await asRealmAdmin('GET')).json()) as { revokeRefreshToken?: unknown; refreshTokenMaxReuse?: unknown }
  if (typeof realm.revokeRefreshToken !== 'boolean' || typeof realm.refreshTokenMaxReuse !== 'number') {
    throw new Error('The fixture realm carries no revokeRefreshToken and refreshTokenMaxReuse')
  }
  return { revokeRefreshToken: realm.revokeRefreshToken, refreshTokenMaxReuse: realm.refreshTokenMaxReuse }
}

async function setRefreshTokenRevocation(revocation: RefreshTokenRevocation): Promise<void> {
  await asRealmAdmin('PUT', revocation)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The SSO Session Idle that the keepalive test gives the realm, in seconds, and how often it rechecks a session. */
const SHORT_SSO_SESSION_IDLE_SECONDS = 10
const RECHECK_EVERY_MS = 2_000
/**
 * How long after SSO Session Idle the test waits at most for Keycloak to drop a session: Keycloak 26.8.1 drops it at
 * the limit, and versions that keep an expired session for a cleanup window keep it up to 180 s longer.
 */
const SESSION_DROP_WINDOW_MS = 180_000

describe('Keycloak sign-in callbacks with the test realm', () => {
  it.each([
    ['alice', true],
    ['grace', true],
    ['bob', false],
    ['erin', false],
    ['carol', false],
  ])('signIn of %s answers %s', async (username, admitted) => {
    const { signIn } = buildAuthCallbacks(DEPS)
    const { account, profile } = await keycloakSignIn(username)

    await expect(signIn({ user: {}, account, profile })).resolves.toBe(admitted)
  })

  it("alice's session token carries her Platform user id, her Keycloak id, her session id and her ID token", async () => {
    const { jwt, session } = buildAuthCallbacks(DEPS)
    const { idToken, account, profile } = await keycloakSignIn('alice')

    const token = await jwt({ token: { name: 'Alice Admin', email: 'alice@libredb.test', sub: crypto.randomUUID() }, user: {}, account, profile })

    expect(token).toMatchObject({
      id: 'platform-alice',
      sub: 'platform-alice',
      keycloakId: ALICE_ID,
      sid: profile.sid,
      idToken,
      refreshToken: account.refresh_token,
      email: 'alice@libredb.test',
      roles: ['PLATFORM_ADMIN'],
      currentTenantId: INSTALL_TENANT.id,
    })
    expect(token?.sid).toEqual(expect.any(String))

    const payload = await session({ session: { user: { name: token?.name, email: token?.email }, expires: '2026-10-23T08:00:00.000Z' }, token: token! })
    expect(JSON.stringify(payload)).not.toContain(idToken)
    expect(JSON.stringify(payload)).not.toContain(account.refresh_token)
    expect(JSON.stringify(payload)).not.toContain(ALICE_ID)
  })

  it("a due recheck keeps alice's session, and ends a token whose user, role or Keycloak session the realm lacks", async () => {
    const signedInAt = Date.now()
    let now = signedInAt
    const { jwt } = buildAuthCallbacks({ ...DEPS, now: () => now })
    const { account, profile } = await keycloakSignIn('alice')
    const token = await jwt({ token: { name: 'Alice Admin', email: 'alice@libredb.test', sub: crypto.randomUUID() }, user: {}, account, profile })

    now = signedInAt + 300_000
    const checkedAt = Math.floor(now / 1000)
    await expect(jwt({ token: token! })).resolves.toMatchObject({ checkedAt, recheckAttemptedAt: checkedAt, directoryDegraded: false })

    const revoked: Array<[Partial<SessionToken>, string]> = [
      // Keycloak answers its own JSON 404 for a user id it does not have.
      [{ keycloakId: '00000000-0000-4000-8000-000000000000' }, 'user-missing'],
      [{ keycloakId: FRANK_ID }, 'user-disabled'],
      [{ keycloakId: CAROL_ID }, 'role-removed'],
      [{ sid: crypto.randomUUID() }, 'session-ended'],
    ]
    for (const [changes, reason] of revoked) {
      await expect(jwt({ token: { ...token!, ...changes } })).resolves.toBeNull()
      expect(logger.info).toHaveBeenLastCalledWith(expect.stringContaining('recheck'), expect.objectContaining({ reason }))
    }
  })

  it(
    'with a short SSO Session Idle, a session that is rechecked keeps its sid past the idle limit, and an unrefreshed session of the same user loses it',
    async () => {
      const originalIdle = await ssoSessionIdle()
      await setSsoSessionIdle(SHORT_SSO_SESSION_IDLE_SECONDS)
      try {
        // Every jwt call is due for a recheck, which refreshes the Keycloak session before the Admin API checks.
        const { jwt } = buildAuthCallbacks({ ...DEPS, sessionRecheck: { intervalSeconds: 1, graceSeconds: 900 } })
        const signInToken = () => ({ name: 'Alice Admin', email: 'alice@libredb.test', sub: crypto.randomUUID() })

        // alice signs in twice, in two Keycloak sessions. The rechecked one signs in first, so Keycloak would drop it
        // no later than the unrefreshed one if nothing refreshed it.
        const first = await keycloakSignIn('alice')
        let rechecked = await jwt({ token: signInToken(), user: {}, account: first.account, profile: first.profile })
        const second = await keycloakSignIn('alice')
        const unrefreshedSince = Date.now()
        const unrefreshed = await jwt({ token: signInToken(), user: {}, account: second.account, profile: second.profile })
        expect(rechecked?.sid).not.toBe(unrefreshed?.sid)

        // Keycloak may expire an idle session only some time after SSO Session Idle, so the test measures that delay:
        // it rechecks the first session until Keycloak no longer lists the second one.
        let unrefreshedListed = true
        while (unrefreshedListed) {
          await sleep(RECHECK_EVERY_MS)
          rechecked = await jwt({ token: rechecked! })
          expect(rechecked).toMatchObject({ sid: first.profile.sid, directoryDegraded: false })
          unrefreshedListed = (await directory.getUserSessionIds(ALICE_ID)).includes(unrefreshed!.sid!)
          if (unrefreshedListed && Date.now() - unrefreshedSince > SHORT_SSO_SESSION_IDLE_SECONDS * 1000 + SESSION_DROP_WINDOW_MS) {
            throw new Error('Keycloak still lists the unrefreshed session long after its SSO Session Idle')
          }
        }
        // Keycloak dropped the second session for its idle limit, which it counts in whole seconds.
        expect(Date.now() - unrefreshedSince).toBeGreaterThanOrEqual((SHORT_SSO_SESSION_IDLE_SECONDS - 1) * 1000)

        // The rechecked session is past the same limit and delay, and Keycloak still has it, under refreshed tokens.
        await expect(directory.getUserSessionIds(ALICE_ID)).resolves.toContain(first.profile.sid)
        expect(rechecked?.refreshToken).not.toBe(first.refreshToken)
        expect(rechecked?.idToken).not.toBe(first.idToken)

        // The unrefreshed session's next recheck finds its Keycloak session gone and ends it.
        await expect(jwt({ token: unrefreshed! })).resolves.toBeNull()
        expect(logger.info).toHaveBeenLastCalledWith(
          expect.stringContaining('recheck'),
          expect.objectContaining({ reason: 'session-ended' }),
        )
      } finally {
        await setSsoSessionIdle(originalIdle)
      }
    },
    SHORT_SSO_SESSION_IDLE_SECONDS * 1000 + SESSION_DROP_WINDOW_MS + 60_000,
  )

  it(
    'with Revoke Refresh Token on, two due rechecks of one session at once keep the session alive past SSO Session Idle',
    async () => {
      const originalIdle = await ssoSessionIdle()
      const originalRevocation = await refreshTokenRevocation()
      // Keycloak 26.8.1 then refuses a refresh token used before and detaches Platform's client from the Keycloak
      // session, so every later refresh of that session is refused, the newest token's too.
      await setRefreshTokenRevocation({ revokeRefreshToken: true, refreshTokenMaxReuse: 0 })
      await setSsoSessionIdle(SHORT_SSO_SESSION_IDLE_SECONDS)
      try {
        // Every jwt call is due for a recheck, which refreshes the Keycloak session before the Admin API checks.
        const { jwt } = buildAuthCallbacks({ ...DEPS, sessionRecheck: { intervalSeconds: 1, graceSeconds: 900 } })
        const signInToken = () => ({ name: 'Alice Admin', email: 'alice@libredb.test', sub: crypto.randomUUID() })
        const writeBacks: Array<[string | undefined, string | undefined]> = []
        const first = await keycloakSignIn('alice')

        // Two requests of the session arrive together with the token of one cookie, and the second one's write-back
        // reaches the browser last.
        const recheckTogether = async (token: SessionToken) => {
          const [one, other] = await Promise.all([jwt({ token }), jwt({ token })])
          expect(one).toMatchObject({ sid: first.profile.sid, directoryDegraded: false })
          expect(other).toMatchObject({ sid: first.profile.sid, directoryDegraded: false })
          writeBacks.push([one?.refreshToken, other?.refreshToken])
          return other!
        }
        let rechecked = (await jwt({ token: signInToken(), user: {}, account: first.account, profile: first.profile }))!
        await sleep(RECHECK_EVERY_MS)
        rechecked = await recheckTogether(rechecked)

        // alice signs in again only now, so if no refresh after this first pair kept the rechecked session alive,
        // Keycloak would drop it no later than this unrefreshed one.
        const second = await keycloakSignIn('alice')
        const unrefreshedSince = Date.now()
        const unrefreshed = await jwt({ token: signInToken(), user: {}, account: second.account, profile: second.profile })

        // Keycloak may expire an idle session only some time after SSO Session Idle, so the test measures that delay:
        // it rechecks the first session in pairs until Keycloak no longer lists the second one.
        let unrefreshedListed = true
        while (unrefreshedListed) {
          await sleep(RECHECK_EVERY_MS)
          rechecked = await recheckTogether(rechecked)
          unrefreshedListed = (await directory.getUserSessionIds(ALICE_ID)).includes(unrefreshed!.sid!)
          if (unrefreshedListed && Date.now() - unrefreshedSince > SHORT_SSO_SESSION_IDLE_SECONDS * 1000 + SESSION_DROP_WINDOW_MS) {
            throw new Error('Keycloak still lists the unrefreshed session long after its SSO Session Idle')
          }
        }
        expect(Date.now() - unrefreshedSince).toBeGreaterThanOrEqual((SHORT_SSO_SESSION_IDLE_SECONDS - 1) * 1000)

        // The rechecked session is past the same limit and delay, and Keycloak still has it.
        await expect(directory.getUserSessionIds(ALICE_ID)).resolves.toContain(first.profile.sid)
        // Each pair spent its refresh token in one grant that Keycloak accepted: both requests wrote back the same new
        // token, and no pair kept a token that an earlier grant had spent.
        for (const [one, other] of writeBacks) expect(other).toBe(one)
        expect(new Set(writeBacks.map(([one]) => one)).size).toBe(writeBacks.length)
        expect(writeBacks.map(([one]) => one)).not.toContain(first.refreshToken)
      } finally {
        await setSsoSessionIdle(originalIdle)
        await setRefreshTokenRevocation(originalRevocation)
      }
    },
    SHORT_SSO_SESSION_IDLE_SECONDS * 1000 + SESSION_DROP_WINDOW_MS + 60_000,
  )
})
