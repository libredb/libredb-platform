import type { KeycloakDirectory } from '../keycloak/directory'
import { KeycloakAuthError, KeycloakPermissionError, KeycloakUnavailableError } from '../keycloak/errors'
import { KeycloakRefreshRefusedError, type RefreshedKeycloakSession } from '../keycloak/token-refresh'
import { logger } from '../logger'

// The recheck of a Platform session against Keycloak: a Keycloak sign-in admits an admin once, so the
// jwt callback asks the directory again every PLATFORM_SESSION_RECHECK_SECONDS whether the session still stands.
// Each due recheck first refreshes the Keycloak session, so an active admin keeps it under the realm's own SSO Session
// Idle; the refresh never decides the verdict, the directory does.

/** The reads of the Keycloak directory that a recheck makes. */
export type SessionDirectory = Pick<KeycloakDirectory, 'getUser' | 'getEffectiveRoles' | 'getUserSessionIds'>

/** PLATFORM_SESSION_RECHECK_SECONDS and PLATFORM_RECHECK_GRACE_SECONDS. */
export interface SessionRecheckSettings {
  /** Seconds from one recheck attempt to the next. */
  intervalSeconds: number
  /** Seconds after the last successful check during which a directory that cannot be read keeps the session. */
  graceSeconds: number
}

/** The fields of a Keycloak session token that the recheck reads and writes. */
export interface RecheckedSession {
  /** The Platform user id, users.id, which the log names. */
  id: string
  /** The Keycloak user id, the `sub` of the ID token. */
  keycloakId: string
  /** The Keycloak session id of the ID token. */
  sid: string | null
  /** The refresh token of the Keycloak session, which each due recheck spends to keep that session alive. */
  refreshToken: string
  /** The raw ID token of the Keycloak session, which a refresh replaces. */
  idToken: string
  /** The last successful check, the sign-in or a recheck that found the session valid, in seconds since the epoch. */
  checkedAt: number
  /** The last recheck attempt, whatever its verdict, in seconds since the epoch. */
  recheckAttemptedAt: number
  /** True while the session lives on its grace, because the last attempt could not read the directory. */
  directoryDegraded: boolean
}

/** Why a recheck ends a session. */
export type RevocationReason = 'user-missing' | 'user-disabled' | 'role-removed' | 'session-ended'

/** A failure of the directory that keeps the session for its grace instead of ending it. */
export type DirectoryFailure = KeycloakUnavailableError | KeycloakAuthError | KeycloakPermissionError

export type SessionVerdict =
  | { status: 'valid' }
  | { status: 'revoked'; reason: RevocationReason }
  | { status: 'unreachable'; error: DirectoryFailure }

export interface SessionRecheckDeps {
  directory: SessionDirectory
  /** Refreshes the Keycloak session of a refresh token and returns its new tokens (token-refresh). */
  refreshKeycloakSession(refreshToken: string): Promise<RefreshedKeycloakSession>
  /** PLATFORM_ADMIN_ROLE: the role the user must still hold. */
  adminRole: string
  settings: SessionRecheckSettings
  /** Now, in seconds since the epoch. */
  now: number
}

/**
 * True when the session should ask the directory: PLATFORM_SESSION_RECHECK_SECONDS after the last attempt, or at once
 * for a degraded session whose grace has passed, which then ends unless the directory answers.
 */
export function isRecheckDue(session: RecheckedSession, now: number, settings: SessionRecheckSettings): boolean {
  if (now - session.recheckAttemptedAt >= settings.intervalSeconds) return true
  return session.directoryDegraded && now - session.checkedAt > settings.graceSeconds
}

/**
 * True when the directory cannot be read now: Keycloak did not answer, or it refused Platform's client credentials or
 * the rights of its service account. A read that fails this way keeps the session on its grace, and every reader that
 * can go on without the directory, such as the license banner, treats it the same way.
 */
export function isDirectoryFailure(error: unknown): error is DirectoryFailure {
  return (
    error instanceof KeycloakUnavailableError ||
    error instanceof KeycloakAuthError ||
    error instanceof KeycloakPermissionError
  )
}

/**
 * Asks the directory whether the session still stands: the user exists, is enabled, holds the admin role and still
 * has the Keycloak session of the token.
 * Only the per-user read GET /users/{id} reads Keycloak's own 404 as a missing user, because getUser answers null for
 * it; Keycloak answers the same 404 for a client or a route it does not have, so a KeycloakNotFoundError from any other
 * read is thrown, like KeycloakConfigError and every error other than a DirectoryFailure.
 */
export async function evaluateSession(
  session: Pick<RecheckedSession, 'keycloakId' | 'sid'>,
  directory: SessionDirectory,
  adminRole: string,
): Promise<SessionVerdict> {
  try {
    const user = await directory.getUser(session.keycloakId)
    if (user === null) return { status: 'revoked', reason: 'user-missing' }
    if (!user.enabled) return { status: 'revoked', reason: 'user-disabled' }
    const roles = await directory.getEffectiveRoles(session.keycloakId)
    if (!roles.includes(adminRole)) return { status: 'revoked', reason: 'role-removed' }
    const sessionIds = await directory.getUserSessionIds(session.keycloakId)
    // A token without sid cannot show that its Keycloak session still exists.
    if (session.sid === null || !sessionIds.includes(session.sid)) return { status: 'revoked', reason: 'session-ended' }
    return { status: 'valid' }
  } catch (error) {
    if (isDirectoryFailure(error)) return { status: 'unreachable', error }
    throw error
  }
}

type SessionTokens = Pick<RecheckedSession, 'refreshToken' | 'idToken'>
type LogContext = { userId: string; keycloakId: string }

/**
 * Spends the session's refresh token, which Keycloak counts as activity on the session, so the realm's SSO Session
 * Idle starts again, and returns the tokens the session keeps: the new ones, or its own when the refresh failed.
 * A failed or refused refresh is logged without any token value and never ends the session: the directory checks
 * decide, so a refresh token that the realm rotated or saw reused cannot end a session by itself.
 */
async function keepKeycloakSessionAlive(
  session: RecheckedSession,
  refresh: SessionRecheckDeps['refreshKeycloakSession'],
  context: LogContext,
): Promise<SessionTokens> {
  try {
    const { refreshToken, idToken } = await refresh(session.refreshToken)
    return { refreshToken, idToken }
  } catch (error) {
    if (error instanceof KeycloakRefreshRefusedError) {
      // The Keycloak session expired or ended, which the directory checks then report, or the token was used already.
      logger.warn('Keycloak session refresh refused; the directory checks decide the session', {
        ...context,
        error: error.message,
      })
    } else if (error instanceof KeycloakUnavailableError) {
      logger.warn('Keycloak session refresh: the token endpoint is unreachable', { ...context, error: error.message })
    } else if (error instanceof KeycloakAuthError) {
      logger.error(
        "Keycloak session refresh: Keycloak refused Platform's client credentials, a configuration error",
        error,
        context,
      )
    } else {
      logger.error(
        'Keycloak session refresh failed unexpectedly',
        error instanceof Error ? error : new Error(String(error)),
        context,
      )
    }
    return { refreshToken: session.refreshToken, idToken: session.idToken }
  }
}

/**
 * Rechecks a Keycloak session once it is due, and otherwise returns it unchanged.
 * A due recheck first refreshes the Keycloak session and keeps the tokens it returns, then asks the directory.
 * A valid verdict renews checkedAt; a revoked verdict ends the session (null).
 * A directory that cannot be read keeps the session, marked directoryDegraded, for PLATFORM_RECHECK_GRACE_SECONDS after
 * the last successful check, and ends it once the grace has passed.
 * The log names the Platform and Keycloak user ids and the verdict, never a token or the Keycloak session id.
 */
export async function recheckSession<T extends RecheckedSession>(session: T, deps: SessionRecheckDeps): Promise<T | null> {
  const { now, settings } = deps
  if (!isRecheckDue(session, now, settings)) return session

  const context = { userId: session.id, keycloakId: session.keycloakId }
  // Before the directory checks, so the Keycloak session they look for has just counted as active.
  const tokens = await keepKeycloakSessionAlive(session, deps.refreshKeycloakSession, context)
  const verdict = await evaluateSession(session, deps.directory, deps.adminRole)
  switch (verdict.status) {
    case 'valid':
      return { ...session, ...tokens, checkedAt: now, recheckAttemptedAt: now, directoryDegraded: false }
    case 'revoked':
      logger.info('Keycloak session ended by the session recheck', { ...context, reason: verdict.reason })
      return null
    case 'unreachable':
      if (verdict.error instanceof KeycloakUnavailableError) {
        logger.warn('Keycloak session recheck: the Admin API is unreachable', { ...context, error: verdict.error.message })
      } else {
        // Keycloak refused the client credentials or the service account's rights: no retry fixes that.
        logger.error(
          "Keycloak session recheck: the Admin API refused Platform's service account, a configuration error",
          verdict.error,
          context,
        )
      }
      if (now - session.checkedAt > settings.graceSeconds) {
        logger.warn('Keycloak session ended: the directory could not be read past the grace', {
          ...context,
          graceSeconds: settings.graceSeconds,
        })
        return null
      }
      return { ...session, ...tokens, recheckAttemptedAt: now, directoryDegraded: true }
  }
}
