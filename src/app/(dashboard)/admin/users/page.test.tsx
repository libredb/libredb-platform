import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// The session that auth() returns: a platform admin.
const session = vi.hoisted(() => ({
  user: { id: 'user-admin', email: 'admin@libredb.example', name: 'Platform Admin' },
  authProvider: 'credentials',
  currentTenantId: 'tenant-platform',
  membershipId: 'member-admin',
  roles: ['PLATFORM_ADMIN'],
  permissions: [],
  accessibleTenants: [],
  directoryDegraded: false,
}))

// The tenant memberships of every tenant, which the page lists.
const findAll = vi.hoisted(() =>
  vi.fn(async () => [
    {
      id: 'member-sarah',
      user: { id: 'user-sarah', email: 'sarah.chen@acme.com', name: 'Sarah Chen', active: true, lastLoginAt: null },
      tenant: { id: 'tenant-acme', name: 'Acme Corp', slug: 'acme-corp' },
      roles: [{ role: { id: 'role-tenant-admin', code: 'TENANT_ADMIN', name: 'TENANT_ADMIN' } }],
    },
  ]),
)

vi.mock('@/shared/lib/auth', () => ({ auth: vi.fn(async () => session) }))
vi.mock('@/features/users/lib/user.repository', () => ({ UserRepository: { findAll } }))
vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }))
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404')
  }),
  redirect: vi.fn(),
}))

import AdminUsersPage from './page'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('AdminUsersPage', () => {
  it('lists the members of every tenant in cloud mode', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')

    render(await AdminUsersPage())

    expect(screen.getByRole('row', { name: /Sarah Chen.*Acme Corp/ })).toBeInTheDocument()
  })

  it('answers 404 in self-hosted mode, whose sign-ins write no tenant membership, before it reads any', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')

    await expect(AdminUsersPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404')
    expect(findAll).not.toHaveBeenCalled()
  })
})
