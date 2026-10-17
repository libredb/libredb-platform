import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const calls: string[] = []
  class RedirectSignal extends Error {
    constructor(readonly url: string) {
      super(`NEXT_REDIRECT ${url}`)
    }
  }
  return {
    calls,
    RedirectSignal,
    signOut: vi.fn(async (options: unknown) => {
      calls.push(`signOut ${JSON.stringify(options)}`)
    }),
    getToken: vi.fn(),
    deleteCookie: vi.fn((name: string) => {
      calls.push(`delete ${name}`)
    }),
    redirect: vi.fn((url: string) => {
      calls.push(`redirect ${url}`)
      throw new RedirectSignal(url)
    }),
    getEndSessionEndpoint: vi.fn(),
    requestHeaders: new Headers({ cookie: 'authjs.session-token=encrypted' }),
  }
})

vi.mock('@/shared/lib/auth', () => ({ signOut: mocks.signOut }))
vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ delete: mocks.deleteCookie }),
  headers: async () => mocks.requestHeaders,
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@/shared/lib/auth-utils', () => ({
  getCurrentUser: async () => ({ id: 'user-1', email: 'alice@libredb.test' }),
}))
vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/shared/lib/runtime-config', () => ({
  getRuntimeConfig: () => ({
    DEPLOYMENT_MODE: 'self-hosted',
    AUTH_URL: 'https://platform.libredb.test',
    AUTH_SECRET: 'current-secret',
    AUTH_SECRET_PREVIOUS: 'previous-secret',
    AUTH_KEYCLOAK_ISSUER: 'https://auth.libredb.test/realms/libredb',
    AUTH_KEYCLOAK_ID: 'libredb-platform',
  }),
}))
vi.mock('@/shared/lib/identity/end-session', async importOriginal => ({
  ...(await importOriginal<typeof import('@/shared/lib/identity/end-session')>()),
  getEndSessionEndpoint: mocks.getEndSessionEndpoint,
}))

import { logoutAction } from './logout'

const END_SESSION_ENDPOINT = 'https://auth.libredb.test/realms/libredb/protocol/openid-connect/logout'

async function logoutRedirect(): Promise<string> {
  const error = await logoutAction().then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  if (!(error instanceof mocks.RedirectSignal)) throw new Error(`logoutAction did not redirect: ${String(error)}`)
  return error.url
}

describe('logoutAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.calls.length = 0
  })

  describe('a Keycloak session', () => {
    beforeEach(() => {
      mocks.getToken.mockResolvedValue({ authProvider: 'keycloak', id: 'user-1', idToken: 'raw.id.token' })
    })

    it('clears the tenant cookie, signs out without a redirect, then redirects to the end-session URL', async () => {
      mocks.getEndSessionEndpoint.mockResolvedValue(END_SESSION_ENDPOINT)

      const url = new URL(await logoutRedirect())

      expect(url.origin + url.pathname).toBe(END_SESSION_ENDPOINT)
      expect(Object.fromEntries(url.searchParams)).toEqual({
        id_token_hint: 'raw.id.token',
        post_logout_redirect_uri: 'https://platform.libredb.test/login',
        client_id: 'libredb-platform',
      })
      expect(mocks.calls).toEqual([
        'delete libredb-current-tenant',
        'signOut {"redirect":false}',
        `redirect ${url.toString()}`,
      ])
      expect(mocks.getEndSessionEndpoint).toHaveBeenCalledWith('https://auth.libredb.test/realms/libredb')
      // The token is read from the request cookies with every secret and the __Secure- cookie of an https AUTH_URL.
      expect(mocks.getToken).toHaveBeenCalledWith({
        req: { headers: mocks.requestHeaders },
        secret: ['current-secret', 'previous-secret'],
        secureCookie: true,
      })
    })

    it('redirects to /login?error=SingleLogoutFailed after clearing the session when discovery fails', async () => {
      mocks.getEndSessionEndpoint.mockRejectedValue(new Error('The discovery document has no end_session_endpoint'))

      expect(await logoutRedirect()).toBe('/login?error=SingleLogoutFailed')
      expect(mocks.calls).toEqual([
        'delete libredb-current-tenant',
        'signOut {"redirect":false}',
        'redirect /login?error=SingleLogoutFailed',
      ])
    })

    it('redirects to /login?error=SingleLogoutFailed when the token carries no ID token', async () => {
      mocks.getToken.mockResolvedValue({ authProvider: 'keycloak', id: 'user-1' })
      mocks.getEndSessionEndpoint.mockResolvedValue(END_SESSION_ENDPOINT)

      expect(await logoutRedirect()).toBe('/login?error=SingleLogoutFailed')
      expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false })
    })
  })

  it('a Credentials session clears the tenant cookie and signs out to /login', async () => {
    mocks.getToken.mockResolvedValue({ authProvider: 'credentials', id: 'user-1' })

    await logoutAction()

    expect(mocks.calls).toEqual(['delete libredb-current-tenant', 'signOut {"redirectTo":"/login"}'])
    expect(mocks.getEndSessionEndpoint).not.toHaveBeenCalled()
  })

  it('without a session token it signs out to /login', async () => {
    mocks.getToken.mockResolvedValue(null)

    await logoutAction()

    expect(mocks.calls).toEqual(['delete libredb-current-tenant', 'signOut {"redirectTo":"/login"}'])
  })
})
