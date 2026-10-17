import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { HeroStatusBar } from './hero-status-bar'

describe('HeroStatusBar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T15:42:07Z'))
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows PLATFORM · LIVE label', () => {
    render(<HeroStatusBar />)
    expect(screen.getByText(/PLATFORM · LIVE/i)).toBeInTheDocument()
  })

  it('displays current UTC time and updates it', () => {
    render(<HeroStatusBar />)
    expect(screen.getByText('UTC 15:42:07')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('UTC 15:42:08')).toBeInTheDocument()
  })

  // A mismatch makes React render the page again on the client, which drops what the user typed into the login form.
  it('hydrates without a mismatch when the clock has moved on since the server render', async () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(<HeroStatusBar />)
    vi.setSystemTime(new Date('2026-04-15T15:42:09Z'))
    const onRecoverableError = vi.fn()

    await act(async () => {
      hydrateRoot(container, <HeroStatusBar />, { onRecoverableError })
    })

    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container).toHaveTextContent('UTC 15:42:09')
  })
})
