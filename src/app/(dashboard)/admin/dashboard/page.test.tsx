import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ROLE_PERMISSIONS } from '@/shared/lib/permissions'

// The session that auth() returns: a member of the platform tenant in cloud mode, whose roles each test sets.
const session = vi.hoisted(() => ({
  user: { id: 'user-devops', email: 'devops@libredb.example', name: 'Platform DevOps' },
  authProvider: 'credentials',
  currentTenantId: 'tenant-platform',
  membershipId: 'member-devops',
  roles: [] as string[],
  permissions: [] as string[],
  accessibleTenants: [],
  directoryDegraded: false,
}))

vi.mock('@/shared/lib/auth', () => ({ auth: vi.fn(async () => session) }))
vi.mock('@/features/tenants/lib/admin-stats.repository', () => ({
  AdminStatsRepository: {
    getStats: vi.fn(async () => ({ tenants: 3, activeTenants: 2, users: 7, connections: 4, queriesToday: 12 })),
    getRecentTenants: vi.fn(async () => []),
  },
}))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import AdminDashboardPage from './page'

function signInAs(role: keyof typeof ROLE_PERMISSIONS) {
  session.roles = [role]
  session.permissions = [...ROLE_PERMISSIONS[role]]
}

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('AdminDashboardPage', () => {
  it('shows the dashboard to PLATFORM_TECH, whose role holds platform.dashboard and sees the Dashboard menu', async () => {
    signInAs('PLATFORM_TECH')

    render(await AdminDashboardPage())

    expect(screen.getByRole('heading', { name: 'Admin Dashboard' })).toBeInTheDocument()
  })

  it('shows the dashboard to PLATFORM_ADMIN', async () => {
    signInAs('PLATFORM_ADMIN')

    render(await AdminDashboardPage())

    expect(screen.getByRole('heading', { name: 'Admin Dashboard' })).toBeInTheDocument()
  })

  it('refuses a session without platform.dashboard', async () => {
    signInAs('TENANT_ADMIN')

    await expect(AdminDashboardPage()).rejects.toThrow('Permission denied: platform.dashboard')
  })
})
