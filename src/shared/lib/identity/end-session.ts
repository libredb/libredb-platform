// RP-initiated logout through the end_session_endpoint of the Keycloak realm.

/** The login page's error code for a logout whose Keycloak session could not be ended. */
export const SINGLE_LOGOUT_FAILED = 'SingleLogoutFailed'

/** Where logoutAction sends a user after it cleared the Platform session but could not build the end-session URL. */
export const SINGLE_LOGOUT_FAILED_URL = `/login?error=${SINGLE_LOGOUT_FAILED}`

/** How long a discovered end_session_endpoint stays cached. */
const DISCOVERY_CACHE_MS = 300_000

/** How long the discovery request may take, so a logout never hangs on an unreachable Keycloak. */
const DISCOVERY_TIMEOUT_MS = 5_000

const cache = new Map<string, { endpoint: string; expiresAt: number }>()

/**
 * The end_session_endpoint of an OIDC issuer, read from its discovery document and cached for 300 seconds.
 * Throws when the document cannot be read or names no end_session_endpoint; a failure is never cached.
 */
export async function getEndSessionEndpoint(issuer: string): Promise<string> {
  const cached = cache.get(issuer)
  if (cached && cached.expiresAt > Date.now()) return cached.endpoint

  const discoveryUrl = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
  const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`The discovery document ${discoveryUrl} answered HTTP ${response.status}`)
  }
  const document: unknown = await response.json()
  const endpoint =
    typeof document === 'object' && document !== null
      ? (document as Record<string, unknown>).end_session_endpoint
      : undefined
  if (typeof endpoint !== 'string' || endpoint === '') {
    throw new Error(`The discovery document ${discoveryUrl} has no end_session_endpoint`)
  }

  cache.set(issuer, { endpoint, expiresAt: Date.now() + DISCOVERY_CACHE_MS })
  return endpoint
}

export interface EndSessionParams {
  /** The end_session_endpoint of the realm. */
  endpoint: string
  /** The raw ID token of the session, which tells Keycloak which session to end without asking the user. */
  idToken: string
  /** Where Keycloak sends the browser afterwards; it must be a post-logout redirect URI of the client. */
  postLogoutRedirectUri: string
  clientId: string
}

/** The URL that ends the Keycloak session of an ID token and returns the browser to Platform. */
export function buildEndSessionUrl({ endpoint, idToken, postLogoutRedirectUri, clientId }: EndSessionParams): string {
  const url = new URL(endpoint)
  url.searchParams.set('id_token_hint', idToken)
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri)
  url.searchParams.set('client_id', clientId)
  return url.toString()
}
