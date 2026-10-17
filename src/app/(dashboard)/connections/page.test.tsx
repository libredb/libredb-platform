import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PERMISSIONS } from '@/shared/lib/permissions'

// The session that auth() returns: a Keycloak admin of the install tenant, unless a test changes it.
const session = vi.hoisted(() => ({
  user: { id: 'user-alice', email: 'alice@libredb.test', name: 'Alice' },
  authProvider: 'keycloak',
  currentTenantId: 'tenant-install',
  membershipId: null,
  roles: ['PLATFORM_ADMIN'],
  permissions: [] as string[],
  accessibleTenants: [],
  directoryDegraded: false,
}))

// The text the license of the install would refuse a new connection with now, or null when it would allow one.
const getNewConnectionRefusal = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null))

// One connection of the install tenant, as the repository returns it.
const findAllByTenant = vi.hoisted(() =>
  vi.fn(async (_tenantId: string) => [
    {
      id: 'connection-1',
      name: 'Orders',
      engine: 'postgres',
      hostSummary: 'db.internal:5432/orders',
      environment: null,
      active: true,
      hasWriteCredential: false,
      createdAt: new Date('2026-10-15T08:30:00.000Z'),
    },
  ]),
)

vi.mock('@/shared/lib/auth', () => ({ auth: vi.fn(async () => session) }))
vi.mock('@/shared/lib/license/install-license-notice', () => ({ getNewConnectionRefusal }))
vi.mock('@/features/connections/lib/database-connection.repository', () => ({
  DatabaseConnectionRepository: { findAllByTenant },
}))
// The list's delete action imports the database client; rendering the page runs no action.
vi.mock('@/features/connections/actions/delete-database-connection', () => ({ deleteDatabaseConnection: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import ConnectionsPage from './page'

const USER_SEATS_REFUSAL =
  'Not enough user seats. Free a seat by revoking all grants of a user, or install a license with more user seats.'

async function renderPage() {
  render(await ConnectionsPage())
}

beforeEach(() => {
  session.roles = ['PLATFORM_ADMIN']
  session.permissions = Object.values(PERMISSIONS)
  getNewConnectionRefusal.mockResolvedValue(null)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('ConnectionsPage', () => {
  it('disables New Connection with the refusal text when the license would refuse a new connection', async () => {
    getNewConnectionRefusal.mockResolvedValue(USER_SEATS_REFUSAL)

    await renderPage()

    const button = screen.getByRole('button', { name: 'New Connection' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(USER_SEATS_REFUSAL)
    expect(screen.queryByRole('link', { name: 'New Connection' })).not.toBeInTheDocument()
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(findAllByTenant).toHaveBeenCalledWith('tenant-install')
  })

  it('links New Connection to the connection form when the license allows a new connection or does not apply', async () => {
    await renderPage()

    expect(screen.getByRole('link', { name: 'New Connection' })).toHaveAttribute('href', '/connections/new')
    expect(screen.queryByRole('button', { name: 'New Connection' })).not.toBeInTheDocument()
    expect(getNewConnectionRefusal).toHaveBeenCalledTimes(1)
  })

  it('asks the license nothing and shows no New Connection to a caller without connection.create', async () => {
    session.roles = ['TENANT_VIEWER']
    session.permissions = [PERMISSIONS.CONNECTION_VIEW]
    getNewConnectionRefusal.mockResolvedValue(USER_SEATS_REFUSAL)

    await renderPage()

    expect(getNewConnectionRefusal).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'New Connection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New Connection' })).not.toBeInTheDocument()
    expect(screen.queryByText(USER_SEATS_REFUSAL)).not.toBeInTheDocument()
    expect(screen.getByText('Orders')).toBeInTheDocument()
  })
})
