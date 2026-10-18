import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'

// The tickets that the mocked inbox query returns, set by each test before it renders.
const inbox = vi.hoisted(() => ({ tickets: [] as unknown[] }))
// The router of the mocked navigation, so a test can see which ticket a hotkey opened.
const router = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => router,
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

/** The inbox beside a select, as a ticket page shows it beside the selects of the ticket's sidebar. */
function renderBesideSelect() {
  const items = [{ value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' }]
  return render(
    <>
      <InboxList />
      <Select items={items} defaultValue="MEDIUM">
        <SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
        <SelectContent>{items.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}</SelectContent>
      </Select>
    </>,
  )
}

/** Presses `key`, whose physical key is `code`, with the keyboard focus on `target`. */
function press(target: Element, key: string, code: string) {
  fireEvent.keyDown(target, { key, code })
  fireEvent.keyUp(target, { key, code })
}

afterEach(() => {
  router.push.mockClear()
})

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

describe('InboxList hotkeys', () => {
  it('opens the highlighted ticket, at first the top one, on Enter typed on the page', () => {
    inbox.tickets = [openTicket('1', 5), openTicket('2', 10)]
    render(<InboxList />)

    press(document.body, 'Enter', 'Enter')

    expect(router.push).toHaveBeenCalledWith('/support/1')
  })

  it('moves the highlight down on j typed on a focused row, and opens that ticket on Enter', () => {
    inbox.tickets = [openTicket('1', 5), openTicket('2', 10)]
    render(<InboxList />)
    const row = screen.getByRole('link', { name: /TKT-1/ })
    row.focus()

    press(row, 'j', 'KeyJ')
    press(row, 'Enter', 'Enter')

    expect(router.push).toHaveBeenCalledWith('/support/2')
  })

  it('leaves j and Enter typed on a focused select to the select, which opens', async () => {
    const user = userEvent.setup()
    inbox.tickets = [openTicket('1', 5), openTicket('2', 10)]
    renderBesideSelect()
    const priority = screen.getByRole('combobox', { name: 'Priority' })
    priority.focus()

    await user.keyboard('j{Enter}')

    expect(router.push).not.toHaveBeenCalled()
    expect(priority).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps the highlight where it was after j typed on a focused select', () => {
    inbox.tickets = [openTicket('1', 5), openTicket('2', 10)]
    renderBesideSelect()
    const priority = screen.getByRole('combobox', { name: 'Priority' })
    priority.focus()

    press(priority, 'j', 'KeyJ')
    press(document.body, 'Enter', 'Enter')

    expect(router.push).toHaveBeenCalledWith('/support/1')
  })
})
