import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { toast } from 'sonner'

// next/font/google is resolved by the Next.js compiler, so each font is its CSS variable here.
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'font-geist-sans' }),
  Geist_Mono: () => ({ variable: 'font-geist-mono' }),
  Inter: () => ({ variable: 'font-inter' }),
}))
// The session provider asks the server for the session; the toaster is what this test covers.
vi.mock('next-auth/react', () => ({ SessionProvider: ({ children }: { children: React.ReactNode }) => children }))

import RootLayout from './layout'

/** Renders the whole document of the layout and returns the theme of the toaster that shows `message`. */
async function toasterThemeOf(message: string): Promise<string | null> {
  render(
    <RootLayout>
      <p>Page</p>
    </RootLayout>,
    { container: document },
  )
  act(() => {
    toast(message)
  })
  return (await screen.findByText(message)).closest('[data-sonner-toaster]')?.getAttribute('data-sonner-theme') ?? null
}

describe('RootLayout', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('shows a toast in the theme of the UI, which is dark by default', async () => {
    expect(await toasterThemeOf('Saved')).toBe('dark')
  })

  it('shows a toast in the light theme when the user chose it', async () => {
    // next-themes keeps the user's choice under the key theme.
    localStorage.setItem('theme', 'light')

    expect(await toasterThemeOf('Saved in the light theme')).toBe('light')
  })
})
