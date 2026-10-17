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
})
