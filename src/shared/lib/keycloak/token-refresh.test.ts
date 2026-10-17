import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeycloakAuthError, KeycloakConfigError, KeycloakUnavailableError } from './errors'
import {
  KeycloakRefreshRefusedError,
  forgetKeycloakSessionRefreshes,
  keycloakSessionRefreshConfig,
  refreshKeycloakSession,
  type KeycloakSessionRefreshConfig,
} from './token-refresh'

const CONFIG: KeycloakSessionRefreshConfig = {
  tokenEndpoint: 'http://keycloak.test:8080/realms/libredb/protocol/openid-connect/token',
  clientId: 'libredb-platform',
  clientSecret: 'client-secret-value',
}

// The refresh token that alice's Platform session holds, and the tokens that a refresh of her Keycloak session returns.
const REFRESH_TOKEN = 'eyJhbGciOiJIUzUxMiJ9.alice-refresh-token-payload.alice-refresh-token-signature'
const NEW_REFRESH_TOKEN = 'eyJhbGciOiJIUzUxMiJ9.alice-refresh-token-payload-2.alice-refresh-token-signature-2'
const NEW_ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.alice-id-token-payload-2.alice-id-token-signature-2'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// The answer of Keycloak 26.8.1 to a refresh_token grant of libredb-platform.
function refreshed(): Response {
  return json(200, {
    access_token: 'alice-access-token-2',
    expires_in: 300,
    refresh_expires_in: 1800,
    refresh_token: NEW_REFRESH_TOKEN,
    token_type: 'Bearer',
    id_token: NEW_ID_TOKEN,
    'not-before-policy': 0,
    session_state: 'b7f1e5a2-0c6d-4f3e-9a51-6f2d8c4e1a90',
    scope: 'openid libredb-roles basic acr email profile web-origins roles',
  })
}

/**
 * A fake Keycloak token endpoint behind an injected fetch, which records each request. A new Keycloak has issued no
 * refresh token yet, so the process forgets the refreshes it shares and remembers.
 */
function fakeTokenEndpoint(answer: (request: Request) => Response | Promise<Response>) {
  forgetKeycloakSessionRefreshes()
  const requests: Request[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    requests.push(request)
    return answer(request)
  })
  return { fetch, requests }
}

function refresh(endpoint: ReturnType<typeof fakeTokenEndpoint>, config = CONFIG) {
  return refreshKeycloakSession(REFRESH_TOKEN, { config, fetch: endpoint.fetch })
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

describe('refreshKeycloakSession', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a refresh posts grant_type refresh_token with the client credentials and returns the new refresh and ID tokens', async () => {
    const endpoint = fakeTokenEndpoint(() => refreshed())

    const tokens = await refresh(endpoint, { ...CONFIG, clientSecret: 's3cret+/=:%' })

    expect(tokens).toEqual({ refreshToken: NEW_REFRESH_TOKEN, idToken: NEW_ID_TOKEN })
    expect(endpoint.requests).toHaveLength(1)
    const [request] = endpoint.requests
    expect(request.method).toBe('POST')
    expect(request.url).toBe(CONFIG.tokenEndpoint)
    // HTTP Basic with the client id and secret form-encoded, as RFC 6749 section 2.3.1 requires.
    expect(request.headers.get('authorization'))
      .toBe(`Basic ${Buffer.from('libredb-platform:s3cret%2B%2F%3D%3A%25').toString('base64')}`)
    expect(request.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/)
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
    })
    // A redirect would carry the refresh token and the client secret elsewhere, and Next.js must never answer from its
    // fetch cache.
    expect(endpoint.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', cache: 'no-store' })
  })

  it('a refresh token that Keycloak refuses throws KeycloakRefreshRefusedError, and a refused client KeycloakAuthError', async () => {
    // Keycloak answers invalid_grant for a session that expired or ended and for a refresh token used up.
    for (const description of ['Token is not active', 'Session not active', 'Maximum allowed refresh token reuse exceeded']) {
      const error = await rejection(refresh(fakeTokenEndpoint(() => json(400, { error: 'invalid_grant', error_description: description }))))
      expect(error).toBeInstanceOf(KeycloakRefreshRefusedError)
    }

    for (const answer of [
      // Keycloak 26.8.1 answers a wrong client secret like this.
      () => json(401, { error: 'unauthorized_client', error_description: 'Invalid client or Invalid client credentials' }),
      () => json(400, { error: 'invalid_client' }),
      () => json(400, { error: 'unauthorized_client' }),
    ]) {
      const error = await rejection(refresh(fakeTokenEndpoint(answer)))
      expect(error).toBeInstanceOf(KeycloakAuthError)
      expect(error.message).toMatch(/AUTH_KEYCLOAK_ID and AUTH_KEYCLOAK_SECRET/)
    }
  })

  it('an answer that is not Keycloak refreshing the session throws KeycloakUnavailableError', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => Promise.reject(new TypeError('fetch failed')),
      () => json(503, { error: 'temporarily_unavailable' }),
      () => new Response('Bad Gateway', { status: 502 }),
      // An edge in front of Keycloak answers with its own body.
      () => new Response('<html>Bad Request</html>', { status: 400, headers: { 'Content-Type': 'text/html' } }),
      () => new Response(null, { status: 302, headers: { Location: 'https://sso.libredb.test/login' } }),
      () => new Response('<html>Sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      () => json(200, { access_token: 'alice-access-token-2', id_token: NEW_ID_TOKEN }),
      () => json(200, { access_token: 'alice-access-token-2', refresh_token: NEW_REFRESH_TOKEN }),
    ]
    for (const answer of answers) {
      await expect(refresh(fakeTokenEndpoint(answer))).rejects.toThrow(KeycloakUnavailableError)
    }
  })

  it('gives up after 5 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let started!: () => void
    const requested = new Promise<void>(resolve => {
      started = resolve
    })
    const hanging = fakeTokenEndpoint(request => {
      started()
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason))
      })
    })
    let outcome: unknown = 'pending'
    const settled = refresh(hanging).then(
      value => {
        outcome = value
      },
      error => {
        outcome = error
      },
    )

    await requested
    await vi.advanceTimersByTimeAsync(4_999)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(outcome).toBeInstanceOf(KeycloakUnavailableError)
    expect((outcome as Error).message).toMatch(/did not answer within 5 s/)
  })

  it('two refreshes of one token at once send one grant and both get the same new tokens', async () => {
    // Keycloak answers once both refreshes have started, so the second one starts while the first is in flight.
    let release!: () => void
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    const endpoint = fakeTokenEndpoint(async () => {
      await released
      return refreshed()
    })

    const first = refresh(endpoint)
    const second = refresh(endpoint)
    release()

    const [firstTokens, secondTokens] = await Promise.all([first, second])
    expect(firstTokens).toEqual({ refreshToken: NEW_REFRESH_TOKEN, idToken: NEW_ID_TOKEN })
    expect(secondTokens).toEqual(firstTokens)
    expect(endpoint.requests).toHaveLength(1)

    // Another refresh token is another Keycloak session's, which gets a grant of its own.
    await refreshKeycloakSession(`${REFRESH_TOKEN}-of-another-session`, { config: CONFIG, fetch: endpoint.fetch })
    expect(endpoint.requests).toHaveLength(2)
  })

  it('a refresh of a token refreshed within 30 s returns the remembered result without a grant', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T08:00:00.000Z') })
    const endpoint = fakeTokenEndpoint(() => refreshed())

    const tokens = await refresh(endpoint)
    vi.setSystemTime(new Date('2026-10-15T08:00:29.999Z'))
    await expect(refresh(endpoint)).resolves.toEqual(tokens)
    expect(endpoint.requests).toHaveLength(1)

    // 30 s after the refresh this process has forgotten it, so the token goes to Keycloak again.
    vi.setSystemTime(new Date('2026-10-15T08:00:30.000Z'))
    await refresh(endpoint)
    expect(endpoint.requests).toHaveLength(2)
  })

  it('a refusal is shared and remembered for 30 s as well, so no other request sends the token again', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T08:00:00.000Z') })
    const endpoint = fakeTokenEndpoint(() => json(400, { error: 'invalid_grant', error_description: 'Token is not active' }))

    const refusals = await Promise.all([rejection(refresh(endpoint)), rejection(refresh(endpoint))])
    vi.setSystemTime(new Date('2026-10-15T08:00:29.999Z'))
    refusals.push(await rejection(refresh(endpoint)))

    for (const refusal of refusals) expect(refusal).toBeInstanceOf(KeycloakRefreshRefusedError)
    expect(endpoint.requests).toHaveLength(1)
  })

  it('the copies of this module that Next.js bundles for the proxy and for the render code share one refresh', async () => {
    // The proxy's jwt callback and a Server Component's auth() read the same cookie in one request, each through its
    // own copy of this module.
    const proxyCopy = await import('./token-refresh')
    vi.resetModules()
    const renderCopy = await import('./token-refresh')
    expect(renderCopy.refreshKeycloakSession).not.toBe(proxyCopy.refreshKeycloakSession)
    const endpoint = fakeTokenEndpoint(() => refreshed())

    const [proxyTokens, renderTokens] = await Promise.all([
      proxyCopy.refreshKeycloakSession(REFRESH_TOKEN, { config: CONFIG, fetch: endpoint.fetch }),
      renderCopy.refreshKeycloakSession(REFRESH_TOKEN, { config: CONFIG, fetch: endpoint.fetch }),
    ])

    expect(renderTokens).toEqual(proxyTokens)
    expect(endpoint.requests).toHaveLength(1)
  })

  it('keeps every token, the client secret and the response body out of its error messages', async () => {
    const marker = 'response-body-marker'
    const answers: Array<() => Response | Promise<Response>> = [
      () => json(400, { error: 'invalid_grant', error_description: marker }),
      () => json(401, { error: 'unauthorized_client', error_description: marker }),
      () => json(500, { error: marker }),
      () => json(200, { refresh_token: marker }),
      () => Promise.reject(new TypeError('fetch failed')),
    ]

    for (const answer of answers) {
      const error = await rejection(refresh(fakeTokenEndpoint(answer)))
      for (const secret of [REFRESH_TOKEN, CONFIG.clientSecret, marker]) {
        expect(`${error.name}: ${error.message}`).not.toContain(secret)
      }
    }
  })
})

describe('keycloakSessionRefreshConfig', () => {
  const CLIENT = { AUTH_KEYCLOAK_ID: 'libredb-platform', AUTH_KEYCLOAK_SECRET: 'client-secret-value' }

  it("refreshes at the issuer's own token endpoint, where the sign-in got the session's tokens", () => {
    expect(keycloakSessionRefreshConfig({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: 'https://auth.libredb.test/realms/libredb' })).toEqual({
      tokenEndpoint: 'https://auth.libredb.test/realms/libredb/protocol/openid-connect/token',
      clientId: 'libredb-platform',
      clientSecret: 'client-secret-value',
    })
    // A Keycloak served under a context path keeps that path.
    expect(keycloakSessionRefreshConfig({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: 'http://localhost:58080/auth/realms/corp' }))
      .toMatchObject({ tokenEndpoint: 'http://localhost:58080/auth/realms/corp/protocol/openid-connect/token' })
  })

  it('throws KeycloakConfigError naming each missing or invalid variable, as in cloud mode', () => {
    expect(() => keycloakSessionRefreshConfig({})).toThrow(KeycloakConfigError)
    expect(() => keycloakSessionRefreshConfig({})).toThrow(/AUTH_KEYCLOAK_ISSUER.*AUTH_KEYCLOAK_ID.*AUTH_KEYCLOAK_SECRET/)
    expect(() => keycloakSessionRefreshConfig({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: 'https://auth.libredb.test/libredb' }))
      .toThrow(/AUTH_KEYCLOAK_ISSUER must be/)
  })
})
