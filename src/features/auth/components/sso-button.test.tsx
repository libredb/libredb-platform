import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Platform's Auth.js instance loads next-auth, whose env.js imports 'next/server' without an extension, which vitest
// cannot resolve; the button's real Server Action runs against this stand-in for its signIn.
const signIn = vi.hoisted(() => vi.fn())

vi.mock('@/shared/lib/auth', () => ({ signIn }))
vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { SSOButton } from './sso-button'

describe('SSOButton', () => {
  it('starts the keycloak sign-in', async () => {
    render(<SSOButton />)

    await userEvent.click(screen.getByRole('button', { name: /continue with sso/i }))

    await waitFor(() => expect(signIn).toHaveBeenCalledWith('keycloak', { redirectTo: '/' }))
  })
})
