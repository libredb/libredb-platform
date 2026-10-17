import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MenuItem } from '@/shared/lib/menu'
import type { CurrentUser } from '@/shared/types'

vi.mock('next/navigation', () => ({
  usePathname: () => '/connections',
}))

// The tenant switcher and user menu import Server Actions that load next-auth,
// which Vitest cannot resolve; the sidebar links are what these tests cover.
vi.mock('./tenant-switcher', () => ({ TenantSwitcher: () => null }))
vi.mock('./user-nav', () => ({ UserNav: () => null }))

import { SidebarProvider } from '@/shared/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'

function item(code: string, name: string, url: string | null, external = false): MenuItem {
  return {
    id: code.toLowerCase(),
    code,
    name,
    url,
    icon: null,
    sortOrder: 0,
    level: 0,
    parentId: null,
    external,
    children: [],
  }
}

function renderSidebar(menus: MenuItem[]) {
  return render(
    <SidebarProvider>
      <AppSidebar deploymentMode="cloud" menus={menus} user={{ accessibleTenants: [] } as unknown as CurrentUser} currentTenant={null} />
    </SidebarProvider>,
  )
}

describe('AppSidebar', () => {
  it('renders an external item as an anchor with target _blank and rel noopener noreferrer', () => {
    renderSidebar([item('STUDIO', 'Studio', 'https://studio.example.test', true)])

    const link = screen.getByRole('link', { name: 'Studio' })
    expect(link).toHaveAttribute('href', 'https://studio.example.test')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders an internal item as a same-tab link', () => {
    renderSidebar([item('CONNECTIONS', 'Connections', '/connections')])

    const link = screen.getByRole('link', { name: 'Connections' })
    expect(link).toHaveAttribute('href', '/connections')
    expect(link).not.toHaveAttribute('target')
  })
})
