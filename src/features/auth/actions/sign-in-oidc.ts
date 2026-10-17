'use server'

import { signIn } from '@/shared/lib/auth'
import { logger } from '@/shared/lib/logger'

/**
 * Starts the Keycloak sign-in of self-hosted mode: Auth.js redirects to Keycloak's authorization endpoint
 * with PKCE, state and nonce, and the callback lands on /, which sends the admin to the landing page.
 * A Server Action, so Next.js protects it against CSRF without a token in the form.
 */
export async function signInWithOidc(): Promise<void> {
  logger.info('Keycloak sign-in initiated')
  await signIn('keycloak', { redirectTo: '/' })
}
