import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DirectoryUser } from '@/shared/lib/keycloak/directory'
import { KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'

// The session that auth() returns: a Keycloak admin of the install tenant.
const session = vi.hoisted(() => ({
  user: { id: 'user-alice', email: 'alice@libredb.test', name: 'Alice' },
  authProvider: 'keycloak',
  currentTenantId: 'tenant-install',
  membershipId: null,
  roles: ['PLATFORM_ADMIN'],
  permissions: [],
  accessibleTenants: [],
  directoryDegraded: false,
}))

const listRoleMembers = vi.hoisted(() => vi.fn<(role: string) => Promise<DirectoryUser[]>>())

vi.mock('@/shared/lib/auth', () => ({ auth: vi.fn(async () => session) }))
// The revoke action imports the database client; rendering the page runs no action.
vi.mock('@/shared/lib/db', () => ({ db: {} }))
vi.mock('@/shared/lib/keycloak/directory', () => ({ getKeycloakDirectory: () => ({ listRoleMembers }) }))
vi.mock('@/shared/lib/runtime-config', () => ({
  getRuntimeConfig: () => ({ PLATFORM_ADMIN_ROLE: 'admin', STUDIO_USER_ROLE: 'user' }),
}))
vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }))
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404')
  }),
  redirect: vi.fn(),
}))

import StudioUsersPage from './page'

function member(username: string): DirectoryUser {
  return { id: `kc-${username}`, username, email: `${username}@libredb.test`, firstName: null, lastName: null, enabled: true }
}

async function renderPage(query: Record<string, string> = {}) {
  render(await StudioUsersPage({ searchParams: Promise.resolve(query) }))
}

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  session.directoryDegraded = false
  listRoleMembers.mockImplementation(async (role) => (role === 'admin' ? [member('alice')] : [member('bob')]))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('StudioUsersPage', () => {
  it('lists the members of both roles and notes that composite-only roles are not listed', async () => {
    await renderPage({ q: 'bo' })

    expect(screen.getByText('A role held only through a composite role is not listed.')).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /\bbob\b/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /\balice\b/ })).not.toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search Studio users' })).toHaveValue('bo')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows the degraded banner instead of the list while Keycloak does not answer', async () => {
    listRoleMembers.mockRejectedValue(new KeycloakUnavailableError('Keycloak Admin API GET /clients did not answer within 5 s'))

    await renderPage()

    expect(screen.getByRole('status')).toHaveTextContent('Keycloak is unreachable')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('reads nothing while the session is degraded, and leaves the banner to the dashboard layout', async () => {
    session.directoryDegraded = true

    await renderPage()

    expect(listRoleMembers).not.toHaveBeenCalled()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('answers 404 in cloud mode', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')

    await expect(renderPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404')
    expect(listRoleMembers).not.toHaveBeenCalled()
  })

  it('a caller without PLATFORM_ADMIN is forbidden', async () => {
    session.roles = ['TENANT_ADMIN']
    try {
      await expect(renderPage()).rejects.toThrow('Permission denied')
      expect(listRoleMembers).not.toHaveBeenCalled()
    } finally {
      session.roles = ['PLATFORM_ADMIN']
    }
  })
})
