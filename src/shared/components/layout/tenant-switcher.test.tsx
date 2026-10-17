import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

// The switch action loads next-auth, which Vitest cannot resolve; these tests cover what the switcher renders.
vi.mock('@/features/auth/actions/switch-tenant', () => ({ switchTenantAction: vi.fn() }))

import { TenantSwitcher } from './tenant-switcher'

const INSTALL_TENANT = { id: 'tenant-install', name: 'Acme', slug: 'default' }
const OTHER_TENANT = { id: 'tenant-other', name: 'Globex', slug: 'globex' }

describe('TenantSwitcher', () => {
  it('self-hosted shows the install tenant without a menu', () => {
    render(
      <TenantSwitcher
        deploymentMode="self-hosted"
        currentTenant={INSTALL_TENANT}
        accessibleTenants={[INSTALL_TENANT, OTHER_TENANT]}
      />,
    )

    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('default')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('Globex')).not.toBeInTheDocument()
  })

  it('cloud mode opens a menu when the user can reach more than one tenant', () => {
    render(
      <TenantSwitcher
        deploymentMode="cloud"
        currentTenant={INSTALL_TENANT}
        accessibleTenants={[INSTALL_TENANT, OTHER_TENANT]}
      />,
    )

    expect(screen.getByRole('button')).toHaveAttribute('aria-haspopup', 'menu')
  })
})
