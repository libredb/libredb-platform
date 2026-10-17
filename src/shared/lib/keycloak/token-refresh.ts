import { createHash } from 'node:crypto'
import { AppError } from '../errors'
import { getRuntimeConfig, type RuntimeConfig } from '../runtime-config'
import { KEYCLOAK_ISSUER_RULE, parseKeycloakIssuer } from './config'
import { KeycloakAuthError, KeycloakConfigError, KeycloakUnavailableError } from './errors'

// Keeps the Keycloak session of a Platform admin alive. Platform reuses the site's own realm and never
// changes its SSO Session Idle, so the session recheck spends the refresh token of the sign-in: Keycloak counts a
// refresh_token grant as activity on the session, which resets the realm's idle timer.

const REQUEST_TIMEOUT_MS = 5_000

/** How long this process remembers the result of a refresh for the requests that still hold the token it spent. */
const REMEMBER_RESULT_MS = 30_000

/** The variables of the validated runtime configuration (`getRuntimeConfig()`) that a refresh reads. */
export type KeycloakSessionRefreshEnv = Partial<
  Pick<RuntimeConfig, 'AUTH_KEYCLOAK_ISSUER' | 'AUTH_KEYCLOAK_ID' | 'AUTH_KEYCLOAK_SECRET'>
>

export interface KeycloakSessionRefreshConfig {
  /** `<issuer>/protocol/openid-connect/token`. */
  tokenEndpoint: string
  clientId: string
  clientSecret: string
}

export interface KeycloakSessionRefreshOptions {
  /** Platform's client and the issuer's token endpoint; the runtime configuration by default. */
  config?: KeycloakSessionRefreshConfig
  /** The fetch implementation; tests inject a fake Keycloak. */
  fetch?: typeof fetch
}

/** The tokens that replace those of the session after a refresh. */
export interface RefreshedKeycloakSession {
  refreshToken: string
  idToken: string
}

/**
 * Keycloak refused the refresh token (400 invalid_grant): the Keycloak session expired or ended, or the realm revokes
 * refresh tokens and this one was used already.
 */
export class KeycloakRefreshRefusedError extends AppError {
  constructor(message: string) {
    super(message, 'KEYCLOAK_REFRESH_REFUSED', 401)
    this.name = 'KeycloakRefreshRefusedError'
  }
}

/**
 * The token endpoint of AUTH_KEYCLOAK_ISSUER and Platform's client. The refresh goes to the issuer, where Auth.js
 * redeemed the sign-in's code, never to KEYCLOAK_ADMIN_URL, which moves only the Admin API calls.
 * Throws one KeycloakConfigError that names every missing or invalid variable, never its value.
 */
export function keycloakSessionRefreshConfig(env: KeycloakSessionRefreshEnv): KeycloakSessionRefreshConfig {
  const problems: string[] = []
  for (const name of ['AUTH_KEYCLOAK_ISSUER', 'AUTH_KEYCLOAK_ID', 'AUTH_KEYCLOAK_SECRET'] as const) {
    if (!env[name]) problems.push(`${name} is required`)
  }
  const issuer = env.AUTH_KEYCLOAK_ISSUER ? parseKeycloakIssuer(env.AUTH_KEYCLOAK_ISSUER) : null
  if (env.AUTH_KEYCLOAK_ISSUER && !issuer) problems.push(`AUTH_KEYCLOAK_ISSUER ${KEYCLOAK_ISSUER_RULE}`)

  // Without problems the last three checks always pass; they narrow the types.
  if (problems.length > 0 || !issuer || !env.AUTH_KEYCLOAK_ID || !env.AUTH_KEYCLOAK_SECRET) {
    throw new KeycloakConfigError(`Invalid Keycloak session refresh configuration: ${problems.join('; ')}`)
  }
  return {
    tokenEndpoint: `${issuer.baseUrl}/realms/${issuer.realm}/protocol/openid-connect/token`,
    clientId: env.AUTH_KEYCLOAK_ID,
    clientSecret: env.AUTH_KEYCLOAK_SECRET,
  }
}

// The `error` code of a Keycloak JSON error body; null for any other body, such as an edge's HTML page.
function oauthErrorCode(contentType: string, body: string): string | null {
  if (!/^application\/json\b/i.test(contentType)) return null
  const fields = parseJsonObject(body)
  return typeof fields?.error === 'string' ? fields.error : null
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The refresh of one refresh token, which every request of this process that holds that token shares. */
interface SharedRefresh {
  /** The new tokens, or the error, of the one token request. */
  readonly result: Promise<RefreshedKeycloakSession>
  /** When this process forgets the result, in milliseconds since the epoch; never while the request is in flight. */
  forgetAt: number
}

// One registry for the whole process, so it lives on globalThis: Next.js bundles separate copies of this module for the
// proxy, the pages and the route handlers, and in one request the proxy and a page both run the jwt callback with the
// refresh token of the cookie that the browser sent, because a Server Component's auth() reads the request's own
// cookie header, not the proxy's write-back.
const SHARED_REFRESHES = Symbol.for('libredb.keycloak.sessionRefreshes')

function sharedRefreshes(): Map<string, SharedRefresh> {
  const scope = globalThis as typeof globalThis & { [SHARED_REFRESHES]?: Map<string, SharedRefresh> }
  return (scope[SHARED_REFRESHES] ??= new Map())
}

/**
 * Refreshes the Keycloak session of a refresh token with Platform's client, which resets the realm's SSO Session Idle,
 * and returns the new refresh token and ID token.
 * Each refresh token is spent once per process: a call while its refresh is in flight, or within 30 s after it settled,
 * gets that refresh's new tokens or error without a request of its own, whatever options it passes. A realm with
 * Revoke Refresh Token on refuses a refresh token used before and then detaches Platform's client from the Keycloak
 * session, which ends the keepalive of that session; sharing the refresh also makes every request that holds the old
 * token write back the same new tokens.
 * Throws KeycloakRefreshRefusedError when Keycloak refuses the refresh token, KeycloakAuthError when it refuses the
 * client credentials, and KeycloakUnavailableError for any other answer, including none within 5 s.
 * The errors name the request and the status, never a token, the client secret or a response body.
 */
export function refreshKeycloakSession(
  refreshToken: string,
  options: KeycloakSessionRefreshOptions = {},
): Promise<RefreshedKeycloakSession> {
  const refreshes = sharedRefreshes()
  const now = Date.now()
  for (const [key, refresh] of refreshes) {
    if (refresh.forgetAt <= now) refreshes.delete(key)
  }

  // Keyed by a digest, so the registry keeps no copy of a refresh token that a realm without Revoke Refresh Token on
  // would still redeem.
  const key = createHash('sha256').update(refreshToken).digest('base64url')
  const known = refreshes.get(key)
  if (known) return known.result

  const refresh: SharedRefresh = { result: requestRefresh(refreshToken, options), forgetAt: Number.POSITIVE_INFINITY }
  refreshes.set(key, refresh)
  const remember = () => {
    refresh.forgetAt = Date.now() + REMEMBER_RESULT_MS
  }
  refresh.result.then(remember, remember)
  return refresh.result
}

/** Forgets every refresh that this process shares or remembers; tests call it for each fake Keycloak they start. */
export function forgetKeycloakSessionRefreshes(): void {
  sharedRefreshes().clear()
}

// The one token request of a refresh.
async function requestRefresh(
  refreshToken: string,
  options: KeycloakSessionRefreshOptions,
): Promise<RefreshedKeycloakSession> {
  const config = options.config ?? keycloakSessionRefreshConfig(getRuntimeConfig())
  const send = options.fetch ?? fetch
  const url = new URL(config.tokenEndpoint)
  const request = `Keycloak token endpoint POST ${url.origin}${url.pathname}`
  // RFC 6749 section 2.3.1: the client id and secret are form-encoded before they are joined for HTTP Basic.
  const credentials = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)
    .toString('base64')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let status: number
  let contentType: string
  let body: string
  try {
    // A redirect is not followed, because it would carry the refresh token and the client secret to another URL, and
    // Next.js must never answer a refresh from its fetch cache.
    const response = await send(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    })
    status = response.status
    contentType = response.headers.get('content-type') ?? ''
    body = await response.text()
  } catch (error) {
    if (controller.signal.aborted) {
      throw new KeycloakUnavailableError(`${request} did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`)
    }
    throw new KeycloakUnavailableError(`${request} could not be reached`, error)
  } finally {
    clearTimeout(timer)
  }

  if (status === 200) {
    const tokens = parseJsonObject(body)
    const newRefreshToken = tokens?.refresh_token
    const idToken = tokens?.id_token
    if (typeof newRefreshToken !== 'string' || newRefreshToken === '' || typeof idToken !== 'string' || idToken === '') {
      throw new KeycloakUnavailableError(`${request} answered ${status} without a refresh token and an ID token`)
    }
    return { refreshToken: newRefreshToken, idToken }
  }

  const error = oauthErrorCode(contentType, body)
  if (status === 400 && error === 'invalid_grant') {
    throw new KeycloakRefreshRefusedError(`${request} answered 400 invalid_grant: Keycloak refused the refresh token`)
  }
  if (status === 401 || (status === 400 && (error === 'invalid_client' || error === 'unauthorized_client'))) {
    throw new KeycloakAuthError(
      `${request} answered ${status}: Keycloak refused the credentials of client ${config.clientId}; ` +
        'check AUTH_KEYCLOAK_ID and AUTH_KEYCLOAK_SECRET',
    )
  }
  throw new KeycloakUnavailableError(`${request} answered ${status}`)
}
