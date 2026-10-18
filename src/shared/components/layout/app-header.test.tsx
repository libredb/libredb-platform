import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

// The path that usePathname returns, set by each test before it renders.
const navigation = vi.hoisted(() => ({ pathname: '/admin/license' }))

vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }))
// The bell loads Server Actions and their queries; the breadcrumb is what most of these tests cover.
vi.mock('@/features/notifications/components/notification-bell', () => ({ NotificationBell: () => null }))

import { SidebarProvider } from '@/shared/components/ui/sidebar'
import { QueryProvider } from '@/shared/providers/query-provider'
import { AppHeader } from './app-header'

function renderHeader(pathname: string) {
  navigation.pathname = pathname
  return render(
    <QueryProvider>
      <SidebarProvider>
        <AppHeader />
      </SidebarProvider>
    </QueryProvider>,
  )
}

/** The text of each breadcrumb, in order. */
function crumbs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-slot="breadcrumb-item"]')].map((item) => item.textContent ?? '')
}

describe('AppHeader', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // No route serves /api/gamification/stats, and nothing records a streak or an achievement yet.
  it('polls no gamification stats, which no route serves', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('Not Found', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    renderHeader('/connections')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('/api/gamification/stats')
  })

  it('labels the License page of the administration in the breadcrumb', () => {
    renderHeader('/admin/license')

    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin')
    expect(screen.getByText('License')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByText('license')).not.toBeInTheDocument()
  })

  it.each([
    ['/studio-users', 'Studio Users'],
    ['/studio-settings', 'Studio Settings'],
  ])('labels %s in the breadcrumb as %s, never by its path segment', (pathname, label) => {
    const { container } = renderHeader(pathname)

    expect(crumbs(container)).toEqual([label])
    expect(screen.getByText(label)).toHaveAttribute('aria-current', 'page')
  })

  // Prisma's @default(cuid()) gives most rows their id, such as a ticket's or a tenant's, and a connection's id is a UUID.
  it.each([
    ['a ticket', '/support/cmvd49x0l0060rls6y8k3055p', ['Support']],
    ['a tenant', '/admin/tenants/cmvd49wv8002trls6b12mxw6e', ['Admin', 'Tenants']],
    ['a connection', '/connections/3a9e5b7c-6d1f-4e28-b0c4-8f2a1d6e9b02', ['Connections']],
  ])('leaves the id of %s out of the breadcrumb', (_page, pathname, expected) => {
    const { container } = renderHeader(pathname)

    expect(crumbs(container)).toEqual(expected)
  })

  it('keeps a segment that is a word, such as the new page of the support inbox', () => {
    const { container } = renderHeader('/support/new')

    expect(crumbs(container)).toEqual(['Support', 'New'])
  })

  // The browser's HTML parser closes an open <li> at the next <li>, so a separator inside an item makes the server's
  // HTML differ from React's tree, and hydration fails on every page with more than one breadcrumb.
  it('puts each breadcrumb separator between the items, never inside an item', () => {
    const { container } = renderHeader('/admin/license')

    const list = container.querySelector('[data-slot="breadcrumb-list"]')!
    expect([...list.children].map((child) => child.getAttribute('data-slot'))).toEqual([
      'breadcrumb-item',
      'breadcrumb-separator',
      'breadcrumb-item',
    ])
    expect(container.querySelector('li li')).toBeNull()
  })
})
