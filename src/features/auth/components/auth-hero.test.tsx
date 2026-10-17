import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AuthHero } from './auth-hero'

describe('AuthHero', () => {
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

  it('composes kicker, title, topology, and supported engines', () => {
    render(<AuthHero />)
    expect(screen.getByText(/Database Access Governance/i)).toBeInTheDocument()
    expect(screen.getByText('Authorize.')).toBeInTheDocument()
    expect(screen.getByText(/GOVERNANCE LAYER/i)).toBeInTheDocument()
    expect(screen.getByText(/Works Across Your Stack/i)).toBeInTheDocument()
    // At least one engine label should render
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument()
  })

  it('does NOT render a live audit stream on the pre-auth page', () => {
    render(<AuthHero />)
    // Audit-stream-like content (timestamps + user emails + verbs) must not appear
    // on the public login page, where it looks like a leak of real customer activity.
    expect(screen.queryByText(/LIVE AUDIT STREAM/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/blocked by RBAC/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/pending approval/i)).not.toBeInTheDocument()
  })

  it('does NOT render a global queries-today counter (aggregate-leak concern)', () => {
    render(<AuthHero />)
    expect(screen.queryByText(/queries governed today/i)).not.toBeInTheDocument()
  })

  it('does NOT render other tenants\' names (breaks multi-tenant isolation)', () => {
    render(<AuthHero />)
    expect(screen.queryByText(/Acme Corp/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Finch Labs/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Orbit Inc/i)).not.toBeInTheDocument()
  })
})
