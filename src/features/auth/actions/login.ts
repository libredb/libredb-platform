'use server'

import { signIn } from '@/shared/lib/auth'
import { isSelfHosted } from '@/shared/lib/deployment'
import { logger } from '@/shared/lib/logger'

interface LoginState {
  error: string | null
}

export async function loginAction(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  // Self-hosted users sign in through Keycloak, so a password never reaches Auth.js.
  if (isSelfHosted()) {
    return { error: 'Password sign-in is disabled' }
  }

  const email = formData.get('email') as string
  const password = formData.get('password') as string

  if (!email || !password) {
    return { error: 'Email and password are required' }
  }

  logger.info('Login attempt', { email })

  try {
    await signIn('credentials', {
      email,
      password,
      redirectTo: '/',
    })
  } catch (error: unknown) {
    // Auth.js throws a NEXT_REDIRECT error on success: rethrow it
    if (error instanceof Error && 'digest' in error && typeof (error as Error & { digest: string }).digest === 'string' && (error as Error & { digest: string }).digest.includes('NEXT_REDIRECT')) {
      throw error
    }
    logger.warn('Login failed', { email })
    return { error: 'Invalid email or password' }
  }

  return { error: null }
}
