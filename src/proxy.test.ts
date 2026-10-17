import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, type NextFetchEvent } from 'next/server'
import type { Session } from 'next-auth'

// next-auth cannot load under vitest (see sso-button.test.tsx), so auth() stands in for its wrapper form, which
// next-auth/lib/index.js implements: the wrapper reads the session, hands it to the handler as request.auth, and appends
// the Set-Cookie headers of that read, which carry the refreshed token, to the handler's response.
// Like the real auth() over the lazy configuration of src/shared/lib/auth.ts, the stand-in is async, so the wrapper form
// answers a promise of the wrapped handler.
type SessionHandler = (request: NextRequest & { auth: Session | null }, event: NextFetchEvent) => Response
const readSession = vi.hoisted(() => vi.fn<() => Promise<Session | null>>())
const auth = vi.hoisted(() =>
  vi.fn(async (handler: SessionHandler) => async (request: NextRequest, event: NextFetchEvent) =>
    handler(Object.assign(request, { auth: await readSession() }), event),
  ),
)

vi.mock('@/shared/lib/auth', () => ({ auth }))

import { proxy } from './proxy'

const EVENT = {} as NextFetchEvent

function sessionWithRoles(roles: string[]): Session {
  return {
    user: { id: 'user-alice', email: 'alice@libredb.test', name: 'Alice' },
    expires: '2026-10-23T00:00:00.000Z',
    authProvider: 'keycloak',
    currentTenantId: 'tenant-install',
    membershipId: null,
    roles,
    permissions: [],
    accessibleTenants: [],
    directoryDegraded: false,
  }
}

async function request(path: string): Promise<Response> {
  const response = await proxy(new NextRequest(`http://localhost:3100${path}`), EVENT)
  if (!(response instanceof Response)) throw new Error(`The proxy answered ${String(response)} for ${path}`)
  return response
}

function passesThrough(response: Response): boolean {
  return response.headers.get('x-middleware-next') === '1'
}

describe('proxy', () => {
  beforeEach(() => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
    readSession.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads the session through the wrapper form of auth, which writes the refreshed token back', async () => {
    readSession.mockResolvedValue(sessionWithRoles(['PLATFORM_ADMIN']))

    await request('/connections')

    // The proxy wraps its handler once, at import; a bare auth() call would drop the refreshed token.
    expect(auth).toHaveBeenCalledTimes(1)
    expect(auth).toHaveBeenCalledWith(expect.any(Function))
    expect(readSession).toHaveBeenCalledTimes(1)
  })

  it('serves a public path without reading the session', async () => {
    for (const path of ['/login', '/api/auth/session', '/api/health']) {
      expect(passesThrough(await request(path)), path).toBe(true)
    }
    expect(readSession).not.toHaveBeenCalled()
  })

  it('sends a request without a session to /login with its path as callbackUrl', async () => {
    readSession.mockResolvedValue(null)

    const response = await request('/connections')

    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('callbackUrl')).toBe('/connections')
  })

  it('sends a session read that holds no user to /login, as it does a missing session', async () => {
    // next-auth 5.0.0-beta.30 handed the handler an error object as request.auth for a malformed callback-url cookie
    // (GHSA-8fpg-xm3f-6cx3), and a truthy request.auth must not count as a session.
    readSession.mockResolvedValue({ message: 'There was a problem with the server configuration.' } as unknown as Session)

    for (const path of ['/connections', '/admin/users']) {
      const response = await request(path)

      expect(response.status, path).toBe(307)
      expect(new URL(response.headers.get('location') ?? '').pathname, path).toBe('/login')
    }
  })

  it('sends a session without PLATFORM_ADMIN or PLATFORM_TECH from /admin to /', async () => {
    readSession.mockResolvedValue(sessionWithRoles(['TENANT_ADMIN']))

    const response = await request('/admin/users')

    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/')
  })

  it('lets a session through, and PLATFORM_ADMIN and PLATFORM_TECH through to /admin', async () => {
    readSession.mockResolvedValue(sessionWithRoles(['TENANT_ADMIN']))
    expect(passesThrough(await request('/connections'))).toBe(true)

    for (const role of ['PLATFORM_ADMIN', 'PLATFORM_TECH']) {
      readSession.mockResolvedValue(sessionWithRoles([role]))
      expect(passesThrough(await request('/admin/users')), role).toBe(true)
    }
  })
})
