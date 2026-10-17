import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SIDEBAR_COOKIE_NAME, SidebarProvider, SidebarTrigger } from './sidebar'

// The cookie name Studio writes. It is assembled so that a source search for
// the bare name only finds code that still writes it.
const STUDIO_COOKIE_NAME = ['sidebar', 'state'].join('_')

function readCookies(): Record<string, string> {
  return Object.fromEntries(
    document.cookie
      .split(';')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf('=')
        return [pair.slice(0, index), pair.slice(index + 1)]
      }),
  )
}

describe('SidebarProvider', () => {
  beforeEach(() => {
    for (const name of Object.keys(readCookies())) {
      document.cookie = `${name}=; path=/; max-age=0`
    }
  })

  it(`toggling the sidebar writes libredb_platform_sidebar_state and never ${STUDIO_COOKIE_NAME}`, () => {
    render(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Sidebar' }))

    const cookies = readCookies()
    expect(cookies).not.toHaveProperty(STUDIO_COOKIE_NAME)
    expect(cookies.libredb_platform_sidebar_state).toBe('false')
    expect(SIDEBAR_COOKIE_NAME).toBe('libredb_platform_sidebar_state')
  })
})
