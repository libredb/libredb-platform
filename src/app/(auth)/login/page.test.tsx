import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LicenseLimitError } from '@/shared/lib/errors'

const getRuntimeConfig = vi.hoisted(() => vi.fn())

// The page reads the deployment mode and STUDIO_PUBLIC_URL from the validated runtime configuration.
vi.mock('@/shared/lib/runtime-config', () => ({ getRuntimeConfig }))
// The forms' Server Actions import Platform's Auth.js instance, whose next-auth import vitest cannot resolve, and the
// database client; rendering the page runs neither.
vi.mock('@/shared/lib/auth', () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }))
vi.mock('@/shared/lib/db', () => ({ db: {} }))

import LoginPage from './page'

const STUDIO_URL = 'https://studio.libredb.test'

async function renderLogin(mode: 'cloud' | 'self-hosted', query: Record<string, string> = {}) {
  getRuntimeConfig.mockReturnValue({
    DEPLOYMENT_MODE: mode,
    STUDIO_PUBLIC_URL: mode === 'self-hosted' ? STUDIO_URL : undefined,
  })
  render(await LoginPage({ searchParams: Promise.resolve(query) }))
}

describe('LoginPage', () => {
  it('self-hosted shows only the SSO button', async () => {
    await renderLogin('self-hosted')

    expect(screen.getByRole('button', { name: /continue with sso/i })).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /start free trial/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /forgot/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('cloud shows only the credentials form and the registration link', async () => {
    await renderLogin('cloud')

    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /start free trial/i })).toHaveAttribute('href', '/register')
    expect(screen.queryByRole('button', { name: /continue with sso/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('explains AccessDenied as the missing admin role with a link to Studio', async () => {
    await renderLogin('self-hosted', { error: 'AccessDenied' })

    expect(screen.getByRole('alert')).toHaveTextContent('Platform requires the admin role')
    expect(screen.getByRole('link', { name: /libredb studio/i })).toHaveAttribute('href', STUDIO_URL)
  })

  it('explains IdentityClaimMissing as an account without an email', async () => {
    await renderLogin('self-hosted', { error: 'IdentityClaimMissing' })

    expect(screen.getByRole('alert')).toHaveTextContent('Your account has no email address')
  })

  it.each([
    ['LICENSE_ADMIN_SEATS', 'Your first sign-in needs a free admin seat'],
    ['LICENSE_EXPIRED', 'Your first sign-in needs a renewed license'],
    ['LICENSE_INVALID', 'Your first sign-in needs a valid license'],
  ] as const)('explains %s as the refusal of the license and not as a missing admin role', async (code, title) => {
    await renderLogin('self-hosted', { error: code })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(title)
    expect(alert).toHaveTextContent(new LicenseLimitError(code).message)
    expect(alert).not.toHaveTextContent('Platform requires the admin role')
    expect(screen.queryByRole('link', { name: /libredb studio/i })).not.toBeInTheDocument()
  })

  // A first sign-in whose admin seats could not be checked failed, and no sign-in is refused for its user seats.
  it.each(['AdminSeatCheckFailed', 'LICENSE_USER_SEATS'])(
    'explains %s as a failed sign-in',
    async (code) => {
      await renderLogin('self-hosted', { error: code })

      expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed')
      expect(screen.getByRole('alert')).not.toHaveTextContent('Platform requires the admin role')
    },
  )

  it('explains any other sign-in error without repeating the code from the URL', async () => {
    await renderLogin('self-hosted', { error: 'Call 555-0100 to restore your account' })

    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed')
    expect(document.body).not.toHaveTextContent('555-0100')
  })
})
