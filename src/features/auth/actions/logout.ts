'use server'

import { getToken } from 'next-auth/jwt'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { signOut } from '@/shared/lib/auth'
import { getAuthSecrets } from '@/shared/lib/auth-secrets'
import { logger } from '@/shared/lib/logger'
import { getCurrentUser } from '@/shared/lib/auth-utils'
import { getRuntimeConfig, type RuntimeConfig } from '@/shared/lib/runtime-config'
import type { AuthToken } from '@/shared/lib/identity/auth-callbacks'
import {
  buildEndSessionUrl,
  getEndSessionEndpoint,
  SINGLE_LOGOUT_FAILED_URL,
} from '@/shared/lib/identity/end-session'

/**
 * Reads the session token of the request, which holds the raw ID token of a Keycloak session that the session payload
 * leaves out. Auth.js names the cookie __Secure-authjs.session-token when AUTH_URL is https.
 */
async function readSessionToken(config: RuntimeConfig): Promise<AuthToken | null> {
  return getToken({
    req: { headers: await headers() },
    secret: getAuthSecrets(config),
    secureCookie: config.AUTH_URL?.startsWith('https://') ?? false,
  }) as Promise<AuthToken | null>
}

/** The URL that ends the Keycloak session of the token and returns the browser to Platform's login page. */
async function endSessionUrl(config: RuntimeConfig, token: AuthToken): Promise<string> {
  if (!token.idToken) throw new Error('The Keycloak session token carries no ID token')
  if (!config.AUTH_KEYCLOAK_ISSUER || !config.AUTH_KEYCLOAK_ID) {
    throw new Error('AUTH_KEYCLOAK_ISSUER and AUTH_KEYCLOAK_ID are required to end a Keycloak session')
  }
  if (!config.AUTH_URL) throw new Error('AUTH_URL is required to end a Keycloak session')
  return buildEndSessionUrl({
    endpoint: await getEndSessionEndpoint(config.AUTH_KEYCLOAK_ISSUER),
    idToken: token.idToken,
    postLogoutRedirectUri: new URL('/login', config.AUTH_URL).toString(),
    clientId: config.AUTH_KEYCLOAK_ID,
  })
}

export async function logoutAction() {
  try {
    const user = await getCurrentUser()
    logger.info('User logout', { userId: user.id, email: user.email })
  } catch {
    // User may already be unauthenticated; continue with cleanup
  }

  const config = getRuntimeConfig()
  const token = await readSessionToken(config)

  // A Keycloak session also ends in Keycloak, otherwise its surviving SSO session signs the user straight back in.
  // When the end-session URL cannot be built, the Platform session is still cleared and /login explains the failure.
  let keycloakLogoutUrl: string | undefined
  if (token?.authProvider === 'keycloak') {
    try {
      keycloakLogoutUrl = await endSessionUrl(config, token)
    } catch (error) {
      logger.error(
        'Single logout through Keycloak failed; only the Platform session is cleared',
        error instanceof Error ? error : new Error(String(error)),
        { userId: token.id },
      )
      keycloakLogoutUrl = SINGLE_LOGOUT_FAILED_URL
    }
  }

  // Clear tenant cookie
  try {
    const cookieStore = await cookies()
    cookieStore.delete('libredb-current-tenant')
  } catch {
    // Cookie cleanup failure should not block logout
  }

  if (keycloakLogoutUrl === undefined) {
    await signOut({ redirectTo: '/login' })
    return
  }

  await signOut({ redirect: false })
  // redirect() throws NEXT_REDIRECT, so it stays outside any try/catch.
  redirect(keycloakLogoutUrl)
}
