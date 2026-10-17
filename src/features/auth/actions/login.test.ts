import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const signIn = vi.hoisted(() => vi.fn())

vi.mock('@/shared/lib/auth', () => ({ signIn }))
vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { loginAction } from './login'

function credentials(email: string, password: string): FormData {
  const form = new FormData()
  form.set('email', email)
  form.set('password', password)
  return form
}

describe('loginAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('self-hosted: refuses without calling signIn', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')

    const result = await loginAction({ error: null }, credentials('bob@example.com', 'a password'))

    expect(result).toEqual({ error: 'Password sign-in is disabled' })
    expect(signIn).not.toHaveBeenCalled()
  })

  it('cloud: signs in with the Credentials provider and lands on /', async () => {
    await loginAction({ error: null }, credentials('bob@example.com', 'a password'))

    expect(signIn).toHaveBeenCalledWith('credentials', {
      email: 'bob@example.com',
      password: 'a password',
      redirectTo: '/',
    })
  })
})
