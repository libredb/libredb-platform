import type { AuthProvider, TenantSummary } from '../../types'
import type { DeploymentMode } from '../deployment'
import { ConfigError, LicenseLimitError } from '../errors'
import type { RefreshedKeycloakSession } from '../keycloak/token-refresh'
import { logger } from '../logger'
import { PERMISSIONS, SYSTEM_ROLES } from '../permissions'
import type { CredentialsUser } from './authorize-credentials'
import { refreshCredentialsToken, type CredentialsAccess } from './credentials-session'
import { IdentityClaimError, readKeycloakClaims, type KeycloakIdentity } from './keycloak-claims'
import type { ProvisionedUser } from './keycloak-provisioning'
import { recheckSession, type SessionDirectory, type SessionRecheckSettings } from './session-recheck'

// The Auth.js callbacks of Platform, built from injected dependencies. This module imports nothing from next-auth, so
// vitest loads it without Next.js; src/shared/lib/auth.ts wires the callbacks into Auth.js, and src/types/next-auth.d.ts
// declares the fields they write on its JWT and Session types.

export const KEYCLOAK_PROVIDER_ID = 'keycloak'
export const CREDENTIALS_PROVIDER_ID = 'credentials'

/** The login page's error code for a Keycloak account whose ID token lacks a claim that Platform needs, such as the email. */
export const IDENTITY_CLAIM_MISSING = 'IdentityClaimMissing'

/** Where signIn sends such an account. */
export const IDENTITY_CLAIM_MISSING_URL = `/login?error=${IDENTITY_CLAIM_MISSING}`

/**
 * The login page's error code for a first sign-in of an admin that failed before the license could admit it, such as
 * when Keycloak could not report the admin seats; the login page shows it as a failed sign-in.
 */
export const ADMIN_SEAT_CHECK_FAILED = 'AdminSeatCheckFailed'

/** Where signIn sends such a sign-in. */
export const ADMIN_SEAT_CHECK_FAILED_URL = `/login?error=${ADMIN_SEAT_CHECK_FAILED}`

/** The token that the callbacks write: the defaults of Auth.js and the fields of a Platform session. */
export type SessionToken = {
  name?: string | null
  email?: string | null
  picture?: string | null
  /** users.id, like id: never the Keycloak `sub` or the random id that Auth.js gives an OAuth sign-in. */
  sub?: string
  /** The Platform user id, users.id. */
  id: string
  authProvider: AuthProvider
  /**
   * When the session's access was last read, in seconds since the epoch: for a Keycloak session, the sign-in or the
   * last recheck that found the session valid.
   */
  checkedAt: number
  currentTenantId: string | null
  membershipId: string | null
  roles: string[]
  permissions: string[]
  accessibleTenants: TenantSummary[]
  /** Keycloak sessions only: the Keycloak user id, the `sub` of the ID token. */
  keycloakId?: string
  /** Keycloak sessions only: the Keycloak session id of the ID token. */
  sid?: string | null
  /** Keycloak sessions only: the raw ID token, the id_token_hint of the Keycloak logout. */
  idToken?: string
  /** Keycloak sessions only: the refresh token of the Keycloak session, which each due recheck spends to keep it alive. */
  refreshToken?: string
  /** Keycloak sessions only: the last recheck attempt, whatever its verdict, in seconds since the epoch. */
  recheckAttemptedAt?: number
  /** Keycloak sessions only: true while the session lives on its grace, because the recheck could not read the directory. */
  directoryDegraded?: boolean
}

/** A Keycloak session token, with the fields that the session recheck reads and writes. */
export type KeycloakSessionToken = SessionToken & {
  authProvider: 'keycloak'
  keycloakId: string
  sid: string | null
  idToken: string
  refreshToken: string
  recheckAttemptedAt: number
  directoryDegraded: boolean
}

/** The token that Auth.js hands the jwt callback: its defaults at a sign-in, and the token of an earlier request after it. */
export type AuthToken = Partial<SessionToken>

/** The fields of the account of a sign-in that the callbacks read. */
export interface SignInAccount {
  provider: string
  type?: string
  providerAccountId?: string
  id_token?: string
  refresh_token?: string
}

export interface SignInParams {
  user?: unknown
  account?: SignInAccount | null
  /** The claims of the ID token for an OIDC sign-in. */
  profile?: Readonly<Record<string, unknown>>
}

export interface JwtParams extends SignInParams {
  token: AuthToken
  trigger?: 'signIn' | 'signUp' | 'update'
  isNewUser?: boolean
}

/** The session that Auth.js builds from the token before the session callback. */
export interface DefaultSession {
  user?: { name?: string | null; email?: string | null; image?: string | null }
  expires: string
}

export interface SessionParams {
  session: DefaultSession
  token: AuthToken
}

/** The session payload, which useSession() also sends to the browser, so it never carries the Keycloak fields of the token. */
export interface SessionPayload {
  user: { id: string; name?: string | null; email?: string | null; image?: string | null }
  expires: string
  authProvider: AuthProvider
  currentTenantId: string | null
  membershipId: string | null
  roles: string[]
  permissions: string[]
  accessibleTenants: TenantSummary[]
  /** True while a Keycloak session lives on its grace because the recheck cannot read the directory; always false otherwise. */
  directoryDegraded: boolean
}

export interface AuthCallbackDeps {
  deploymentMode: DeploymentMode
  /** PLATFORM_ROLE_CLAIM: the flat ID-token claim that carries the Keycloak roles. */
  roleClaim: string
  /** PLATFORM_ADMIN_ROLE: the role that admits a Keycloak account to Platform. */
  adminRole: string
  /**
   * Lets an account with the admin role sign in under the license of the install, and creates the Platform user of
   * its first sign-in when the license allows another admin seat; throws LicenseLimitError otherwise
   * (keycloak-provisioning).
   */
  admitKeycloakAdmin(identity: KeycloakIdentity): Promise<void>
  /** Creates or refreshes the Platform user of a Keycloak account (keycloak-provisioning). */
  provisionKeycloakUser(identity: KeycloakIdentity): Promise<ProvisionedUser>
  /** The one tenant of a self-hosted install, which throws ConfigError unless exactly one tenant exists. */
  getInstallTenant(): Promise<TenantSummary>
  /** Reads the access of a Credentials session in a tenant (credentials-session). */
  loadCredentialsAccess(userId: string, tenantId: string | null): Promise<CredentialsAccess | null>
  /** The value of the request's libredb-current-tenant cookie. */
  readTenantCookie(): Promise<string | undefined>
  /**
   * The Keycloak directory that a Keycloak session is rechecked against (session-recheck). Only a Keycloak session
   * asks for it, so cloud mode, which has no Keycloak variables, never builds it.
   */
  keycloakDirectory(): SessionDirectory
  /** Refreshes the Keycloak session of a refresh token, which a due recheck does first (token-refresh). */
  refreshKeycloakSession(refreshToken: string): Promise<RefreshedKeycloakSession>
  /** PLATFORM_SESSION_RECHECK_SECONDS and PLATFORM_RECHECK_GRACE_SECONDS. */
  sessionRecheck: SessionRecheckSettings
  /** Now, in milliseconds since the epoch. */
  now(): number
}

// A Keycloak token also carries what the recheck reads and refreshes; a Keycloak token from before the recheck or the
// session refresh existed lacks it.
function hasRecheckFields(token: AuthToken): boolean {
  return (
    typeof token.keycloakId === 'string' &&
    token.keycloakId !== '' &&
    (typeof token.sid === 'string' || token.sid === null) &&
    typeof token.idToken === 'string' &&
    token.idToken !== '' &&
    typeof token.refreshToken === 'string' &&
    token.refreshToken !== '' &&
    typeof token.recheckAttemptedAt === 'number' &&
    typeof token.directoryDegraded === 'boolean'
  )
}

function isKeycloakSessionToken(token: SessionToken): token is KeycloakSessionToken {
  return token.authProvider === 'keycloak' && hasRecheckFields(token)
}

// Auth.js encrypts the token with AUTH_SECRET, so only Platform writes it, but a token from before these fields existed
// is still readable and ends its session instead of passing for a session with no tenant or no roles.
function isSessionToken(token: AuthToken): token is SessionToken {
  return (
    (token.authProvider === 'credentials' || (token.authProvider === 'keycloak' && hasRecheckFields(token))) &&
    typeof token.id === 'string' &&
    typeof token.checkedAt === 'number' &&
    token.currentTenantId !== undefined &&
    token.membershipId !== undefined &&
    Array.isArray(token.roles) &&
    Array.isArray(token.permissions) &&
    Array.isArray(token.accessibleTenants)
  )
}

/** The signIn, jwt and session callbacks of Auth.js. */
export function buildAuthCallbacks(deps: AuthCallbackDeps) {
  const nowInSeconds = () => Math.floor(deps.now() / 1000)

  /**
   * Admits a Keycloak account with the admin role once the license of the install admits it. An account with a
   * Platform user always signs in; the first sign-in of one without needs a free admin seat and a license that has not
   * expired, and is otherwise sent to the login page with the code of the refusal, such as LICENSE_ADMIN_SEATS.
   * Auth.js answers an error thrown here with AccessDenied, which the login page explains as a missing admin role, so a
   * first sign-in whose admission fails, such as when Keycloak cannot report the admin seats, is logged and sent to
   * ADMIN_SEAT_CHECK_FAILED_URL instead.
   */
  async function admitAdmin(identity: KeycloakIdentity): Promise<true | string> {
    try {
      await deps.admitKeycloakAdmin(identity)
      return true
    } catch (error) {
      if (error instanceof LicenseLimitError) {
        logger.warn('Keycloak sign-in refused: the license admits no new admin', {
          keycloakId: identity.sub,
          code: error.code,
        })
        return `/login?error=${error.code}`
      }
      logger.error(
        'Keycloak sign-in failed: the admin seats of the license could not be checked',
        error instanceof Error ? error : new Error(String(error)),
        { keycloakId: identity.sub },
      )
      return ADMIN_SEAT_CHECK_FAILED_URL
    }
  }

  /**
   * Admits a Credentials account in cloud mode, which authorizeCredentials has checked, and a Keycloak account only
   * when the role claim holds PLATFORM_ADMIN_ROLE and the license admits it (admitAdmin); false makes Auth.js refuse the
   * sign-in with the error AccessDenied.
   * A Keycloak sign-in without the ID token or the refresh token of its session goes on to jwt without the admission,
   * because jwt fails it before anything is written, and the admission would create its Platform user and take an admin
   * seat for a sign-in that cannot succeed. jwt raises a ConfigError for a missing refresh token and a plain Error
   * for a missing ID token.
   * Any other provider is refused. A Credentials sign-in in self-hosted mode and a Keycloak sign-in in cloud mode are
   * configuration errors, because buildProviders registers neither, so a regressed provider list admits no one.
   */
  async function signIn({ account, profile }: SignInParams): Promise<boolean | string> {
    if (account?.provider === CREDENTIALS_PROVIDER_ID) {
      if (deps.deploymentMode !== 'cloud') {
        throw new ConfigError('Platform signs in with a password in cloud mode only')
      }
      return true
    }
    if (account?.provider !== KEYCLOAK_PROVIDER_ID) return false
    if (deps.deploymentMode !== 'self-hosted') {
      throw new ConfigError('Platform signs in through Keycloak in self-hosted mode only')
    }

    let identity: KeycloakIdentity
    try {
      identity = readKeycloakClaims(profile, deps.roleClaim)
    } catch (error) {
      if (!(error instanceof IdentityClaimError)) throw error
      logger.warn('Keycloak sign-in refused: the ID token lacks a claim Platform needs', { claim: error.claim })
      return IDENTITY_CLAIM_MISSING_URL
    }
    if (!identity.roles.includes(deps.adminRole)) {
      logger.info('Keycloak sign-in refused: the account lacks the Platform admin role', {
        keycloakId: identity.sub,
        role: deps.adminRole,
      })
      return false
    }
    if (account.id_token === undefined || account.refresh_token === undefined) return true
    return admitAdmin(identity)
  }

  // A Keycloak sign-in is a Platform admin of the install tenant with every permission and no membership, so the
  // permission checks of the cloud code paths keep working unchanged. Keycloak has just issued the ID
  // token, so the sign-in counts as a successful check, and the first recheck follows PLATFORM_SESSION_RECHECK_SECONDS later.
  async function keycloakSignIn(token: AuthToken, account: SignInAccount, profile: SignInParams['profile']): Promise<KeycloakSessionToken> {
    const identity = readKeycloakClaims(profile, deps.roleClaim)
    // signIn has refused every other sign-in; the check stays next to the admin session that this token grants.
    if (deps.deploymentMode !== 'self-hosted' || !identity.roles.includes(deps.adminRole)) {
      throw new Error('A Keycloak sign-in that signIn refuses reached the jwt callback')
    }
    // Both token checks come before any write, because signIn lets a sign-in without either token through without
    // the license admission.
    if (account.id_token === undefined) throw new Error('The Keycloak sign-in carries no ID token')
    // Without a refresh token Platform could never keep the Keycloak session alive, and the realm's SSO Session Idle
    // would end an active admin's session.
    if (account.refresh_token === undefined) {
      throw new ConfigError(
        'The Keycloak sign-in carries no refresh token: the Platform client in Keycloak must have "Use refresh tokens" on',
      )
    }

    // The tenant comes first, so that an install without exactly one tenant fails before it writes a user.
    const tenant = await deps.getInstallTenant()
    const user = await deps.provisionKeycloakUser(identity)
    const now = nowInSeconds()
    return {
      name: user.name,
      email: user.email,
      picture: token.picture,
      // Auth.js put a random id in sub (@auth/core callback.js:216-234); the session is keyed by users.id.
      sub: user.id,
      id: user.id,
      authProvider: 'keycloak',
      checkedAt: now,
      roles: [SYSTEM_ROLES.PLATFORM_ADMIN],
      permissions: Object.values(PERMISSIONS),
      currentTenantId: tenant.id,
      membershipId: null,
      accessibleTenants: [{ id: tenant.id, name: tenant.name, slug: tenant.slug }],
      keycloakId: identity.sub,
      sid: identity.sid,
      idToken: account.id_token,
      // Kept beside the ID token in the encrypted JWT, never in the session payload.
      refreshToken: account.refresh_token,
      recheckAttemptedAt: now,
      directoryDegraded: false,
    }
  }

  // Auth.js hands jwt the user that authorizeCredentials returned, whose access already went through membershipAccess.
  function credentialsSignIn(token: AuthToken, user: CredentialsUser): SessionToken {
    return {
      name: token.name,
      email: token.email,
      picture: token.picture,
      sub: user.id,
      id: user.id,
      authProvider: 'credentials',
      checkedAt: nowInSeconds(),
      currentTenantId: user.currentTenantId,
      membershipId: user.membershipId,
      roles: user.roles,
      permissions: user.permissions,
      accessibleTenants: user.accessibleTenants,
    }
  }

  /**
   * Builds the token at a sign-in and keeps it current afterwards.
   * A Keycloak token is rechecked against the directory every PLATFORM_SESSION_RECHECK_SECONDS, after a refresh of its
   * Keycloak session that keeps that session alive (session-recheck).
   * A Credentials token re-reads its access once it is older than 60 seconds and follows the tenant switch cookie in
   * cloud mode; in self-hosted mode it ends at once, because no Keycloak recheck would ever end it.
   * Returning null ends the session. So does an error thrown on a later request, such as a KeycloakNotFoundError that the
   * recheck does not read as a verdict: Auth.js logs it and clears the session cookie.
   */
  async function jwt({ token, user, account, profile }: JwtParams): Promise<SessionToken | null> {
    if (account) {
      if (account.provider === KEYCLOAK_PROVIDER_ID) return keycloakSignIn(token, account, profile)
      if (account.provider === CREDENTIALS_PROVIDER_ID) return credentialsSignIn(token, user as CredentialsUser)
      throw new Error(`Platform has no sign-in provider ${account.provider}`)
    }

    if (!isSessionToken(token)) return null
    if (isKeycloakSessionToken(token)) {
      return recheckSession(token, {
        directory: deps.keycloakDirectory(),
        refreshKeycloakSession: deps.refreshKeycloakSession,
        adminRole: deps.adminRole,
        settings: deps.sessionRecheck,
        now: nowInSeconds(),
      })
    }
    if (deps.deploymentMode === 'self-hosted') {
      // signIn refuses a password sign-in in self-hosted mode, so this token was signed elsewhere with the same
      // AUTH_SECRET, such as by a server in cloud mode.
      logger.info('Credentials session ended: self-hosted mode signs in through Keycloak only', { userId: token.id })
      return null
    }
    return refreshCredentialsToken(token, {
      now: nowInSeconds(),
      requestedTenantId: await deps.readTenantCookie(),
      loadAccess: deps.loadCredentialsAccess,
    })
  }

  /**
   * Builds the session payload from the token, without idToken, refreshToken, sid, keycloakId, checkedAt or
   * recheckAttemptedAt.
   */
  async function session({ session, token }: SessionParams): Promise<SessionPayload> {
    if (!isSessionToken(token)) throw new Error('The session token lacks the Platform session fields')
    return {
      user: { ...session.user, id: token.id },
      expires: session.expires,
      authProvider: token.authProvider,
      currentTenantId: token.currentTenantId,
      membershipId: token.membershipId,
      roles: token.roles,
      permissions: token.permissions,
      accessibleTenants: token.accessibleTenants,
      directoryDegraded: isKeycloakSessionToken(token) && token.directoryDegraded,
    }
  }

  return { signIn, jwt, session }
}
