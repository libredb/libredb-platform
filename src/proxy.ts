import { NextResponse } from 'next/server'
import type { NextFetchEvent, NextRequest } from 'next/server'
import type { NextAuthRequest } from 'next-auth'
import { auth } from '@/shared/lib/auth'
import { getDeploymentMode } from '@/shared/lib/deployment'
import { isPublicPath } from '@/shared/lib/public-paths'

const ADMIN_PATHS = ['/admin']

// The wrapper form of auth() reads the session and appends the Set-Cookie headers of that read to the response, so the
// token that the jwt callback refreshed reaches the browser: the recheck of a Keycloak session and the
// re-read of a Credentials session then run once per interval instead of on every request. A bare auth() call inside
// the proxy drops them (node_modules/next-auth/lib/index.js, handleAuth).
// src/shared/lib/auth.ts builds its configuration lazily, which makes auth() async: the wrapper form then resolves to
// the wrapped handler instead of returning it, although its type says otherwise, and Promise.resolve() covers both.
// The handler declares the event parameter so that TypeScript picks the proxy overload of auth(), not the route one.
const requireSession = Promise.resolve(
  auth((request: NextAuthRequest, _event: NextFetchEvent) => {
    const { pathname } = request.nextUrl
    const session = request.auth

    // No session, or one that the jwt callback has just ended
    if (!session) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('callbackUrl', pathname)
      return NextResponse.redirect(loginUrl)
    }

    // Check admin routes
    if (ADMIN_PATHS.some(p => pathname.startsWith(p))) {
      const isAdmin = session.roles.includes('PLATFORM_ADMIN') || session.roles.includes('PLATFORM_TECH')
      if (!isAdmin) {
        return NextResponse.redirect(new URL('/', request.url))
      }
    }

    return NextResponse.next()
  }),
)

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  // Public paths are served before the session is read, so Auth.js's own routes stay the only writer of its cookies
  // there, and the health probes never depend on it.
  if (isPublicPath(request.nextUrl.pathname, getDeploymentMode())) {
    return NextResponse.next()
  }

  return (await requireSession)(request, event)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
