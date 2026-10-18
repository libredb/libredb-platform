import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import { TicketList } from './ticket-list'

const STATUS_VALUES = [
  { code: 'OPEN', name: 'Open', colorCode: null },
  { code: 'RESOLVED', name: 'Resolved', colorCode: null },
]
const PRIORITY_VALUES = [
  { code: 'MEDIUM', name: 'Medium', colorCode: null },
  { code: 'URGENT', name: 'Urgent', colorCode: null },
]

/** The value each filter of the list shows, in the order Status, Priority. */
function filterValues(): string[] {
  return screen.getAllByRole('combobox').map((trigger) => trigger.querySelector('[data-slot="select-value"]')?.textContent ?? '')
}

describe('TicketList', () => {
  it('shows its status and priority filters by the names their options show, never by ALL or a code', async () => {
    render(
      <TicketList
        tickets={[]}
        canCreate={false}
        statusValues={STATUS_VALUES}
        priorityValues={PRIORITY_VALUES}
        categoryValues={[]}
        userMap={{}}
      />,
    )
    expect(filterValues()).toEqual(['All Statuses', 'All Priorities'])

    await userEvent.click(screen.getAllByRole('combobox')[0])
    await userEvent.click(await screen.findByRole('option', { name: 'Open' }))
    await userEvent.click(screen.getAllByRole('combobox')[1])
    await userEvent.click(await screen.findByRole('option', { name: 'Urgent' }))

    expect(filterValues()).toEqual(['Open', 'Urgent'])
  })
})
