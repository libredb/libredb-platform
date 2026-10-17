import { afterEach, describe, it, expect, vi } from 'vitest'
import { createKeycloakAdminClient, type KeycloakAdminClient } from './admin-client'
import type { KeycloakAdminConfig } from './config'
import {
  KeycloakAuthError,
  KeycloakNotFoundError,
  KeycloakPermissionError,
  KeycloakUnavailableError,
} from './errors'

const CONFIG: KeycloakAdminConfig = {
  realm: 'libredb',
  adminBaseUrl: 'http://keycloak.test:8080/admin/realms/libredb',
  tokenEndpoint: 'http://keycloak.test:8080/realms/libredb/protocol/openid-connect/token',
  clientId: 'libredb-platform',
  clientSecret: 'client-secret-value',
}

// Bodies as Keycloak 26.8.1 sends them.
const UNAUTHORIZED = { error: 'HTTP 401 Unauthorized' }
const FORBIDDEN = { error: 'HTTP 403 Forbidden' }

type Handler = (request: Request) => Response | Promise<Response>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function issued(accessToken: string, expiresIn = 300): Response {
  return json(200, { access_token: accessToken, expires_in: expiresIn, token_type: 'Bearer' })
}

/**
 * A fake Keycloak behind an injected fetch: `token` answers the token endpoint, by default with the tokens
 * access-token-value-1, -2 and so on, and `admin` answers every Admin API request.
 * It records each request and the most requests it ever had in flight.
 */
function fakeKeycloak(handlers: { token?: Handler; admin: Handler }) {
  const tokenRequests: Request[] = []
  const adminRequests: Request[] = []
  let tokensIssued = 0
  let inFlight = 0
  let peak = 0
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      if (request.url === CONFIG.tokenEndpoint) {
        tokenRequests.push(request)
        return await (handlers.token ? handlers.token(request) : issued(`access-token-value-${++tokensIssued}`))
      }
      adminRequests.push(request)
      return await handlers.admin(request)
    } finally {
      inFlight -= 1
    }
  })
  return {
    fetch,
    tokenRequests,
    adminRequests,
    get peak() {
      return peak
    },
  }
}

function authorizations(requests: Request[]): Array<string | null> {
  return requests.map(request => request.headers.get('authorization'))
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected a rejection')
}

function clientFor(keycloak: ReturnType<typeof fakeKeycloak>, config = CONFIG): KeycloakAdminClient {
  return createKeycloakAdminClient(config, { fetch: keycloak.fetch })
}

describe('createKeycloakAdminClient', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('caches the service token until 30 s before expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: new Date('2026-10-15T08:00:00Z') })
    const keycloak = fakeKeycloak({ admin: () => json(200, 7) })
    const client = clientFor(keycloak)

    await expect(client.get('/users/count')).resolves.toBe(7)
    vi.advanceTimersByTime(269_999)
    await client.get('/users/count')
    expect(keycloak.tokenRequests).toHaveLength(1)

    vi.advanceTimersByTime(1)
    await client.get('/users/count')
    expect(keycloak.tokenRequests).toHaveLength(2)
    expect(authorizations(keycloak.adminRequests)).toEqual([
      'Bearer access-token-value-1',
      'Bearer access-token-value-1',
      'Bearer access-token-value-2',
    ])
  })

  it('requests the token with client_credentials and HTTP Basic credentials form-encoded as RFC 6749 requires', async () => {
    const keycloak = fakeKeycloak({ admin: () => json(200, []) })
    const client = clientFor(keycloak, { ...CONFIG, clientSecret: 's3cret+/=:%' })

    await client.get('/users', { search: 'alice' })

    const [token] = keycloak.tokenRequests
    expect(token.method).toBe('POST')
    expect(token.headers.get('authorization'))
      .toBe(`Basic ${Buffer.from('libredb-platform:s3cret%2B%2F%3D%3A%25').toString('base64')}`)
    expect(token.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/)
    expect(await token.text()).toBe('grant_type=client_credentials')

    const [admin] = keycloak.adminRequests
    expect(admin.method).toBe('GET')
    expect(admin.url).toBe('http://keycloak.test:8080/admin/realms/libredb/users?search=alice')
    expect(admin.headers.get('accept')).toBe('application/json')
    // A redirect would carry the credentials elsewhere, and Next.js must never answer from its fetch cache.
    expect(keycloak.fetch).toHaveBeenCalledTimes(2)
    for (const [, init] of keycloak.fetch.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', cache: 'no-store' })
    }
  })

  it('refreshes the token once on a 401, then throws KeycloakAuthError', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Keycloak rejects the cached token once, as after a restart: one new token, one retry.
    const recovering = fakeKeycloak({
      admin: request =>
        request.headers.get('authorization') === 'Bearer access-token-value-1' ? json(401, UNAUTHORIZED) : json(200, 7),
    })
    await expect(clientFor(recovering).get('/users/count')).resolves.toBe(7)
    expect(recovering.tokenRequests).toHaveLength(2)
    expect(authorizations(recovering.adminRequests)).toEqual(['Bearer access-token-value-1', 'Bearer access-token-value-2'])

    // Keycloak rejects every token: one new token, then KeycloakAuthError.
    const rejecting = fakeKeycloak({ admin: () => json(401, UNAUTHORIZED) })
    const error = await rejection(clientFor(rejecting).get('/users/count'))
    expect(error).toBeInstanceOf(KeycloakAuthError)
    expect(error.message).toMatch(/libredb-platform/)
    expect(rejecting.tokenRequests).toHaveLength(2)
    expect(rejecting.adminRequests).toHaveLength(2)
  })

  it('a token endpoint answer of 400 or 401 throws KeycloakAuthError without calling the Admin API', async () => {
    for (const [status, body] of [
      [400, { error: 'invalid_request' }],
      [401, { error: 'unauthorized_client', error_description: 'Invalid client or Invalid client credentials' }],
    ] as const) {
      const keycloak = fakeKeycloak({ token: () => json(status, body), admin: () => json(200, []) })

      const error = await rejection(clientFor(keycloak).get('/users'))

      expect(error).toBeInstanceOf(KeycloakAuthError)
      expect(error.message).toMatch(/AUTH_KEYCLOAK_ID/)
      expect(error.message).toMatch(/AUTH_KEYCLOAK_SECRET/)
      expect(keycloak.adminRequests).toHaveLength(0)
    }
  })

  it('a 403 throws KeycloakPermissionError naming view-users and view-clients', async () => {
    const keycloak = fakeKeycloak({ admin: () => json(403, FORBIDDEN) })

    const error = await rejection(clientFor(keycloak).get('/clients', { clientId: 'libredb' }))

    expect(error).toBeInstanceOf(KeycloakPermissionError)
    expect(error.message).toMatch(/view-users/)
    expect(error.message).toMatch(/view-clients/)
    expect(keycloak.tokenRequests).toHaveLength(1)
    expect(keycloak.adminRequests).toHaveLength(1)
  })

  it('a 404 with a Keycloak JSON body throws KeycloakNotFoundError', async () => {
    // Keycloak 26 answers { error }, and older versions answer some missing resources with { errorMessage }.
    for (const body of [{ error: 'User not found' }, { errorMessage: 'Could not find client' }]) {
      const keycloak = fakeKeycloak({ admin: () => json(404, body) })

      const error = await rejection(clientFor(keycloak).get('/users/00000000-0000-4000-8000-000000000000'))

      expect(error).toBeInstanceOf(KeycloakNotFoundError)
      expect(error.message).toMatch(/404/)
    }
  })

  it('a 404 with an HTML body, a 5xx and a timeout throw KeycloakUnavailableError', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response('<html><body>Not Found</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }),
      () => new Response(null, { status: 404 }),
      () => json(404, { message: 'no Route matched with those values' }),
      () => new Response('{"error":"not json content"}', { status: 404, headers: { 'Content-Type': 'text/plain' } }),
      () => json(500, { error: 'unknown_error' }),
      () => new Response('Bad Gateway', { status: 502 }),
      () => json(503, {}),
      () => new Response(null, { status: 302, headers: { Location: 'https://sso.libredb.test/login' } }),
      () => new Response('<html>Sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      () => Promise.reject(new TypeError('fetch failed')),
    ]
    for (const answer of answers) {
      const error = await rejection(clientFor(fakeKeycloak({ admin: answer })).get('/users'))

      expect(error).toBeInstanceOf(KeycloakUnavailableError)
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let adminStarted!: () => void
    const started = new Promise<void>(resolve => {
      adminStarted = resolve
    })
    const hanging = fakeKeycloak({
      admin: request => {
        adminStarted()
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason))
        })
      },
    })
    let outcome: unknown = 'pending'
    const settled = clientFor(hanging).get('/users').then(
      value => {
        outcome = value
      },
      error => {
        outcome = error
      },
    )

    await started
    await vi.advanceTimersByTimeAsync(4_999)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(outcome).toBeInstanceOf(KeycloakUnavailableError)
    expect((outcome as Error).message).toMatch(/did not answer within 5 s/)
  })

  it('a token endpoint 404, 5xx, network failure or malformed answer throws KeycloakUnavailableError, never KeycloakNotFoundError', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      // A realm missing from Keycloak, as a wrong issuer or KEYCLOAK_ADMIN_URL produces, is no missing user.
      () => json(404, { error: 'Realm does not exist' }),
      () => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }),
      () => json(503, {}),
      () => Promise.reject(new TypeError('fetch failed')),
      () => json(200, { token_type: 'Bearer' }),
      () => json(200, { access_token: 'access-token-value-x', expires_in: 'soon' }),
      () => new Response('<html>Sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ]
    for (const answer of answers) {
      const keycloak = fakeKeycloak({ token: answer, admin: () => json(200, []) })

      const error = await rejection(clientFor(keycloak).get('/users'))

      expect(error).toBeInstanceOf(KeycloakUnavailableError)
      expect(keycloak.adminRequests).toHaveLength(0)
    }
  })

  it('getPaged requests first and max=100 until a short page', async () => {
    const users = Array.from({ length: 237 }, (_, index) => ({ id: `user-${index}` }))
    const paging = (list: unknown[]) =>
      fakeKeycloak({
        admin: request => {
          const url = new URL(request.url)
          const first = Number(url.searchParams.get('first'))
          const max = Number(url.searchParams.get('max'))
          return json(200, list.slice(first, first + max))
        },
      })

    const keycloak = paging(users)
    await expect(clientFor(keycloak).getPaged('/users', { briefRepresentation: true })).resolves.toEqual(users)
    expect(keycloak.adminRequests.map(request => new URL(request.url).search)).toEqual([
      '?briefRepresentation=true&first=0&max=100',
      '?briefRepresentation=true&first=100&max=100',
      '?briefRepresentation=true&first=200&max=100',
    ])

    // A list of exactly 100 takes a second request, whose empty page is the short one.
    const hundred = paging(users.slice(0, 100))
    await expect(clientFor(hundred).getPaged('/users')).resolves.toHaveLength(100)
    expect(hundred.adminRequests).toHaveLength(2)

    // An endpoint that ignores max would never end the loop, and a body that is no list is no page.
    for (const page of [users.slice(0, 101), { id: 'user-0' }]) {
      const error = await rejection(clientFor(fakeKeycloak({ admin: () => json(200, page) })).getPaged('/users'))

      expect(error).toBeInstanceOf(KeycloakUnavailableError)
    }
  })

  it('never runs more than 8 calls at once', async () => {
    const gates: Array<() => void> = []
    const keycloak = fakeKeycloak({
      admin: async () => {
        await new Promise<void>(release => gates.push(release))
        return json(200, [])
      },
    })
    const client = clientFor(keycloak)

    const calls = Array.from({ length: 20 }, (_, index) => client.get(`/users/user-${index}`))
    await vi.waitFor(() => expect(gates).toHaveLength(8))
    for (let released = 0; released < 20; released += 1) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0))
      gates.shift()!()
    }
    await Promise.all(calls)

    expect(keycloak.adminRequests).toHaveLength(20)
    expect(keycloak.tokenRequests).toHaveLength(1)
    expect(keycloak.peak).toBe(8)
  })

  it('never logs a token, the client secret or a response body, and keeps them out of error messages', async () => {
    const spies = (['debug', 'log', 'info', 'warn', 'error'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    )
    const marker = 'response-body-marker'
    const scenarios: Array<{ token?: Handler; admin: Handler }> = [
      {
        admin: request =>
          request.headers.get('authorization') === 'Bearer access-token-value-1'
            ? json(401, { error: marker })
            : json(200, [{ id: marker }]),
      },
      { admin: () => json(401, { error: marker }) },
      { admin: () => json(403, { error: marker }) },
      { admin: () => json(404, { error: marker }) },
      { admin: () => new Response(`<html>${marker}</html>`, { status: 404, headers: { 'Content-Type': 'text/html' } }) },
      { admin: () => json(500, { error: marker }) },
      { admin: () => new Response(marker, { status: 200 }) },
      { token: () => json(401, { error: 'unauthorized_client', error_description: marker }), admin: () => json(200, []) },
      { token: () => json(200, { error: marker }), admin: () => json(200, []) },
    ]

    const messages: string[] = []
    for (const scenario of scenarios) {
      try {
        await clientFor(fakeKeycloak(scenario)).get('/users')
      } catch (error) {
        messages.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      }
    }

    const logged = spies.flatMap(spy => spy.mock.calls.flat().map(String))
    expect(messages).toHaveLength(scenarios.length - 1)
    expect(logged.length).toBeGreaterThan(0)
    for (const text of [...logged, ...messages]) {
      expect(text).not.toContain('access-token-value')
      expect(text).not.toContain(CONFIG.clientSecret)
      expect(text).not.toContain(marker)
    }
  })
})

describe('getKeycloakAdminClient', () => {
  const VARIABLES = [
    'NODE_ENV',
    'DEPLOYMENT_MODE',
    'DATABASE_URL',
    'AUTH_SECRET',
    'AUTH_SECRET_PREVIOUS',
    'AUTH_URL',
    'STUDIO_PUBLIC_URL',
    'AUTH_KEYCLOAK_ISSUER',
    'AUTH_KEYCLOAK_ID',
    'AUTH_KEYCLOAK_SECRET',
    'KEYCLOAK_ADMIN_URL',
    'BRIDGE_SEAL_PUBLIC_KEY',
  ]
  const CLOUD = {
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'cloud',
    DATABASE_URL: 'postgresql://libredb_platform:db-password-value@db.internal:5432/libredb?schema=platform',
    AUTH_SECRET: 'auth-secret-value-of-at-least-32-characters',
  }

  function stubEnv(env: Record<string, string>) {
    for (const name of VARIABLES) vi.stubEnv(name, env[name])
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('shares one client per process, built from the runtime configuration', async () => {
    stubEnv({
      ...CLOUD,
      DEPLOYMENT_MODE: 'self-hosted',
      STUDIO_PUBLIC_URL: 'https://studio.libredb.test',
      AUTH_KEYCLOAK_ISSUER: 'https://auth.libredb.test/realms/libredb',
      AUTH_KEYCLOAK_ID: 'libredb-platform',
      AUTH_KEYCLOAK_SECRET: 'client-secret-value',
      // The recipient key of Studio's lsb1 test vectors, a published test key.
      BRIDGE_SEAL_PUBLIC_KEY: 'b6-f045B6re3Ue7V8Cr5jO9ApZzyOxGk659gM3tn5wE',
    })
    vi.resetModules()
    const { getKeycloakAdminClient } = await import('./admin-client')

    expect(getKeycloakAdminClient()).toBe(getKeycloakAdminClient())
  })

  it('throws KeycloakConfigError when the Keycloak variables are unset, as in cloud mode', async () => {
    stubEnv(CLOUD)
    vi.resetModules()
    const { getKeycloakAdminClient } = await import('./admin-client')
    const { KeycloakConfigError: FreshKeycloakConfigError } = await import('./errors')

    expect(() => getKeycloakAdminClient()).toThrow(FreshKeycloakConfigError)
  })
})
