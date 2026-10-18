import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/license' }))
// The bell and the streak load Server Actions and their queries; the breadcrumb is what this test covers.
vi.mock('@/features/notifications/components/notification-bell', () => ({ NotificationBell: () => null }))
vi.mock('@/features/gamification/components/streak-display', () => ({ StreakDisplay: () => null }))

import { SidebarProvider } from '@/shared/components/ui/sidebar'
import { AppHeader } from './app-header'

describe('AppHeader', () => {
  it('labels the License page of the administration in the breadcrumb', () => {
    render(
      <SidebarProvider>
        <AppHeader />
      </SidebarProvider>,
    )

    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin')
    expect(screen.getByText('License')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByText('license')).not.toBeInTheDocument()
  })

  // The browser's HTML parser closes an open <li> at the next <li>, so a separator inside an item makes the server's
  // HTML differ from React's tree, and hydration fails on every page with more than one breadcrumb.
  it('puts each breadcrumb separator between the items, never inside an item', () => {
    const { container } = render(
      <SidebarProvider>
        <AppHeader />
      </SidebarProvider>,
    )

    const list = container.querySelector('[data-slot="breadcrumb-list"]')!
    expect([...list.children].map((child) => child.getAttribute('data-slot'))).toEqual([
      'breadcrumb-item',
      'breadcrumb-separator',
      'breadcrumb-item',
    ])
    expect(container.querySelector('li li')).toBeNull()
  })
})
