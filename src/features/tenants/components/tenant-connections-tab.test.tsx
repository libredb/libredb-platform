import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TenantConnectionsTab, type ConnectionView } from './tenant-connections-tab'

const ENVELOPE = 'lsb1.read-envelope-that-must-never-render'

function connection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: '0192f0c4-0000-7000-8000-000000000001',
    name: 'Orders',
    engine: 'postgres',
    hostSummary: 'db.internal:5432/orders',
    active: true,
    createdAt: '2026-10-15T09:30:00.000Z',
    ...overrides,
  }
}

describe('TenantConnectionsTab', () => {
  it('shows the engine and the host summary and never a credential', () => {
    // A row as the database holds it, sealed credentials included, reaches the tab only through ConnectionView.
    const row = { ...connection(), readSecret: ENVELOPE, writeSecret: ENVELOPE, password: 'plain-password' }

    const { container } = render(<TenantConnectionsTab connections={[row]} />)

    expect(screen.getByRole('columnheader', { name: 'Engine' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Host' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Type' })).not.toBeInTheDocument()
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(screen.getByText('postgres')).toBeInTheDocument()
    expect(screen.getByText('db.internal:5432/orders')).toBeInTheDocument()
    expect(container.textContent).not.toContain(ENVELOPE)
    expect(container.textContent).not.toContain('plain-password')
  })

  it('shows an empty state for a tenant without connections', () => {
    render(<TenantConnectionsTab connections={[]} />)

    expect(screen.getByText('No connections')).toBeInTheDocument()
  })
})
