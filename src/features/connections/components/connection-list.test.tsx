import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../actions/delete-database-connection', () => ({ deleteDatabaseConnection: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ConnectionList, type ConnectionListItem } from './connection-list'

const ORDERS: ConnectionListItem = {
  id: 'connection-1',
  name: 'Orders',
  engine: 'postgres',
  hostSummary: 'db.internal:5432/orders',
  environment: null,
  active: true,
  hasWriteCredential: false,
  createdAt: '2026-10-15T08:30:00.000Z',
}

const USER_SEATS_REFUSAL =
  'Not enough user seats. Free a seat by revoking all grants of a user, or install a license with more user seats.'

afterEach(() => {
  vi.clearAllMocks()
})

describe('ConnectionList', () => {
  it('links New Connection to the connection form while the license allows a new connection', () => {
    render(<ConnectionList connections={[ORDERS]} canCreate canDelete={false} createRefusal={null} />)

    expect(screen.getByRole('link', { name: 'New Connection' })).toHaveAttribute('href', '/connections/new')
    expect(screen.queryByRole('button', { name: 'New Connection' })).not.toBeInTheDocument()
  })

  it('disables New Connection with the refusal text when the license would refuse a new connection', () => {
    render(<ConnectionList connections={[ORDERS]} canCreate canDelete={false} createRefusal={USER_SEATS_REFUSAL} />)

    const button = screen.getByRole('button', { name: 'New Connection' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(USER_SEATS_REFUSAL)
    expect(screen.getByText(USER_SEATS_REFUSAL)).toBeVisible()
    expect(screen.queryByRole('link', { name: 'New Connection' })).not.toBeInTheDocument()
    // The connections stay listed and open.
    expect(screen.getByText('Orders')).toBeInTheDocument()
  })

  it('shows no New Connection and no refusal without connection.create', () => {
    render(<ConnectionList connections={[ORDERS]} canCreate={false} canDelete={false} createRefusal={null} />)

    expect(screen.queryByRole('link', { name: 'New Connection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New Connection' })).not.toBeInTheDocument()
  })
})
