import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// The tickets that the mocked inbox query returns, set by each test before it renders.
const inbox = vi.hoisted(() => ({ tickets: [] as unknown[] }))

vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/support',
}))
vi.mock('../hooks/use-inbox', () => ({
  useInbox: () => ({ data: { tickets: inbox.tickets }, isLoading: false, error: null }),
}))

import { InboxList } from './inbox-list'

/** An open ticket whose last activity was `minutesAgo` minutes before now. */
function openTicket(id: string, minutesAgo: number) {
  const lastActivityAt = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return {
    id,
    ticketNumber: `TKT-${id}`,
    subject: `Ticket ${id}`,
    priority: 'MEDIUM',
    createdAt: lastActivityAt,
    firstResponseAt: null,
    resolvedAt: null,
    lastActivityAt,
    tags: [],
  }
}

describe('InboxList', () => {
  it('counts one ticket in the singular and more tickets in the plural', () => {
    inbox.tickets = [openTicket('1', 5)]
    const { rerender } = render(<InboxList />)
    expect(screen.getByText('1 ticket')).toBeInTheDocument()

    inbox.tickets = [openTicket('1', 5), openTicket('2', 5)]
    rerender(<InboxList />)
    expect(screen.getByText('2 tickets')).toBeInTheDocument()
  })

  it('tells in English how long ago a ticket was last active', () => {
    inbox.tickets = [openTicket('1', 5)]
    render(<InboxList />)

    expect(screen.getByText('5 minutes')).toBeInTheDocument()
  })
})
