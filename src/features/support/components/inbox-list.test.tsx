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

  // A tag's own colour as text on a tint of that colour stays under the 4.5:1 contrast of WCAG AA in both themes.
  it("writes a ticket's tag name in the theme's foreground colour on a tint of the tag's colour", () => {
    inbox.tickets = [{ ...openTicket('1', 5), tags: [{ tag: { id: 'tag-bug', name: 'bug', colorCode: '#ef4444' } }] }]
    render(<InboxList />)

    const chip = screen.getByText('bug')
    expect(chip).toHaveClass('text-foreground')
    expect(chip.style.color).toBe('')
    expect(chip.style.backgroundColor).not.toBe('')
  })
})
