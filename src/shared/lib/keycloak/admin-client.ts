import { logger } from '../logger'
import { getRuntimeConfig } from '../runtime-config'
import { keycloakAdminConfig, type KeycloakAdminConfig } from './config'
import {
  KeycloakAuthError,
  KeycloakNotFoundError,
  KeycloakPermissionError,
  KeycloakUnavailableError,
} from './errors'

const REQUEST_TIMEOUT_MS = 5_000
const MAX_CONCURRENT_CALLS = 8
const PAGE_SIZE = 100
// A cached token is replaced this long before Keycloak's expires_in runs out.
const TOKEN_REFRESH_MARGIN_MS = 30_000

export type QueryValue = string | number | boolean
export type Query = Readonly<Record<string, QueryValue | undefined>>

/**
 * A read-only client of the Keycloak Admin API for the service account of Platform's client.
 * A path is relative to `<base>/admin/realms/<realm>` and starts with `/`; the caller encodes its segments.
 */
export interface KeycloakAdminClient {
  /** Sends GET `path` and returns its JSON body. */
  get<T>(path: string, query?: Query): Promise<T>
  /** Reads every page of a list with `first` and `max=100` until a page holds fewer than 100 items. */
  getPaged<T>(path: string, query?: Query): Promise<T[]>
}

export interface KeycloakAdminClientOptions {
  /** The fetch implementation; tests inject a fake Keycloak. */
  fetch?: typeof fetch
}

interface Answer {
  status: number
  contentType: string
  body: string
}

interface CachedToken {
  accessToken: string
  refreshAt: number
}

// Runs at most `max` tasks at once; a finished task hands its slot to the oldest waiting one.
function createLimiter(max: number) {
  let running = 0
  const waiting: Array<() => void> = []
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (running < max) running += 1
    else await new Promise<void>(resolve => waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running -= 1
    }
  }
}

// Names a request in errors and logs: the origin and path only, never the query, a token or a body.
function describeRequest(what: string, url: URL): string {
  return `${what} ${url.origin}${url.pathname}`
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

// Keycloak answers every error as JSON with an `error` field (older versions: `errorMessage`).
// An edge or a proxy in front of it answers with HTML, plain text or an empty body instead.
function isKeycloakErrorBody(answer: Answer): boolean {
  if (!/^application\/json\b/i.test(answer.contentType)) return false
  const parsed = parseJson(answer.body)
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return false
  const body = parsed.value as Record<string, unknown>
  return typeof body.error === 'string' || typeof body.errorMessage === 'string'
}

/** Builds a client with its own token cache and its own 8 call slots; `getKeycloakAdminClient()` shares one. */
export function createKeycloakAdminClient(
  config: KeycloakAdminConfig,
  options: KeycloakAdminClientOptions = {},
): KeycloakAdminClient {
  const send = options.fetch ?? fetch
  const limit = createLimiter(MAX_CONCURRENT_CALLS)
  const tokenUrl = new URL(config.tokenEndpoint)
  const tokenRequest = describeRequest('Keycloak token endpoint POST', tokenUrl)
  // RFC 6749 section 2.3.1: the client id and secret are form-encoded before they are joined for HTTP Basic,
  // and Keycloak decodes them, so a secret with + or % in it still matches.
  const basicCredentials = Buffer.from(
    `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
  ).toString('base64')

  let cachedToken: CachedToken | undefined
  let pendingToken: Promise<string> | undefined

  // One exchange holds a call slot from the request until its body is read, and gives up after 5 s.
  // Redirects are not followed, because they would carry the credentials to another URL, and Next.js
  // must never answer an Admin API call from its fetch cache.
  function exchange(url: URL, init: RequestInit, request: string): Promise<Answer> {
    return limit(async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await send(url, {
          ...init,
          redirect: 'manual',
          cache: 'no-store',
          signal: controller.signal,
        })
        const body = await response.text()
        return { status: response.status, contentType: response.headers.get('content-type') ?? '', body }
      } catch (error) {
        if (controller.signal.aborted) {
          throw new KeycloakUnavailableError(`${request} did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`)
        }
        throw new KeycloakUnavailableError(`${request} could not be reached`, error)
      } finally {
        clearTimeout(timer)
      }
    })
  }

  async function requestToken(): Promise<string> {
    const requestedAt = Date.now()
    const answer = await exchange(
      tokenUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicCredentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      },
      tokenRequest,
    )
    if (answer.status === 400 || answer.status === 401) {
      throw new KeycloakAuthError(
        `${tokenRequest} answered ${answer.status}: Keycloak refused the credentials of client ${config.clientId}; ` +
          'check AUTH_KEYCLOAK_ID, AUTH_KEYCLOAK_SECRET and that the client has service accounts enabled',
      )
    }
    // Any other failure, including a 404 for a realm that does not exist, makes the directory unreachable;
    // it never means that a user is missing.
    if (answer.status < 200 || answer.status > 299) {
      throw new KeycloakUnavailableError(`${tokenRequest} answered ${answer.status}`)
    }
    const parsed = parseJson(answer.body)
    const fields: Record<string, unknown> = parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
      ? (parsed.value as Record<string, unknown>)
      : {}
    const accessToken = fields.access_token
    const expiresIn = fields.expires_in
    if (typeof accessToken !== 'string' || accessToken === '' || typeof expiresIn !== 'number' || !(expiresIn > 0)) {
      throw new KeycloakUnavailableError(
        `${tokenRequest} answered ${answer.status} without an access token and its lifetime`,
      )
    }
    cachedToken = { accessToken, refreshAt: requestedAt + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS }
    return accessToken
  }

  // Concurrent callers share one token request.
  function serviceToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.refreshAt) return Promise.resolve(cachedToken.accessToken)
    pendingToken ??= requestToken().finally(() => {
      pendingToken = undefined
    })
    return pendingToken
  }

  // Drops a token the Admin API refused, unless a concurrent caller has already replaced it.
  function discardToken(accessToken: string): void {
    if (cachedToken?.accessToken === accessToken) cachedToken = undefined
  }

  function adminUrl(path: string, query: Query = {}): URL {
    if (!path.startsWith('/')) throw new TypeError(`Keycloak Admin API paths start with /: ${path}`)
    const url = new URL(`${config.adminBaseUrl}${path}`)
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
    return url
  }

  function adminGet(url: URL, accessToken: string, request: string): Promise<Answer> {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    return exchange(url, { method: 'GET', headers }, request)
  }

  async function get<T>(path: string, query?: Query): Promise<T> {
    const url = adminUrl(path, query)
    const request = describeRequest('Keycloak Admin API GET', url)
    const firstToken = await serviceToken()
    let answer = await adminGet(url, firstToken, request)
    if (answer.status === 401) {
      // Keycloak refuses a token it no longer knows, such as after a restart; one new token gets one retry.
      logger.warn('Keycloak Admin API refused the service token, requesting a new one', { request })
      discardToken(firstToken)
      answer = await adminGet(url, await serviceToken(), request)
      if (answer.status === 401) {
        throw new KeycloakAuthError(
          `${request} answered 401 to a new service-account token of client ${config.clientId}`,
        )
      }
    }

    if (answer.status === 403) {
      throw new KeycloakPermissionError(
        `${request} answered 403: the service account of client ${config.clientId} needs the realm-management roles ` +
          'view-users and view-clients',
      )
    }
    if (answer.status === 404) {
      if (isKeycloakErrorBody(answer)) throw new KeycloakNotFoundError(`${request} answered 404`)
      throw new KeycloakUnavailableError(`${request} answered 404 without a Keycloak error body`)
    }
    if (answer.status < 200 || answer.status > 299) {
      throw new KeycloakUnavailableError(`${request} answered ${answer.status}`)
    }
    const parsed = parseJson(answer.body)
    if (!parsed.ok) {
      throw new KeycloakUnavailableError(`${request} answered ${answer.status} with a body that is not JSON`)
    }
    return parsed.value as T
  }

  async function getPaged<T>(path: string, query: Query = {}): Promise<T[]> {
    const request = describeRequest('Keycloak Admin API GET', adminUrl(path))
    const items: T[] = []
    for (let first = 0; ; first += PAGE_SIZE) {
      const page = await get<unknown>(path, { ...query, first, max: PAGE_SIZE })
      if (!Array.isArray(page)) throw new KeycloakUnavailableError(`${request} answered a body that is not a list`)
      // An endpoint that ignored max would never answer a short page.
      if (page.length > PAGE_SIZE) {
        throw new KeycloakUnavailableError(`${request} answered ${page.length} items to max=${PAGE_SIZE}`)
      }
      items.push(...(page as T[]))
      if (page.length < PAGE_SIZE) return items
    }
  }

  return { get, getPaged }
}

let processClient: KeycloakAdminClient | undefined

/**
 * The client of this process, built from the validated runtime configuration on first use,
 * so every caller shares its token cache and its 8 call slots.
 * Throws KeycloakConfigError when the Keycloak variables are unset, as in cloud mode.
 */
export function getKeycloakAdminClient(): KeycloakAdminClient {
  processClient ??= createKeycloakAdminClient(keycloakAdminConfig(getRuntimeConfig()))
  return processClient
}
