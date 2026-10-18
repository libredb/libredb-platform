import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
// The create Server Action imports the database client; choosing a priority creates no ticket.
vi.mock('../actions/create-ticket', () => ({ createTicket: vi.fn() }))
// The composer's editor is what reply-composer.test.tsx covers; this test reads the form's selects.
vi.mock('./reply-composer', () => ({ ReplyComposer: () => null }))

import { TicketForm } from './ticket-form'

const PRIORITY_VALUES = [
  { code: 'LOW', name: 'Low' },
  { code: 'MEDIUM', name: 'Medium' },
  { code: 'HIGH', name: 'High' },
  { code: 'URGENT', name: 'Urgent' },
]
const CATEGORY_VALUES = [
  { code: 'GENERAL', name: 'General' },
  { code: 'BILLING', name: 'Billing' },
  { code: 'TECHNICAL', name: 'Technical' },
]

/** The value each select of the form shows, in the order Priority, Category. */
function selectValues(): string[] {
  return screen.getAllByRole('combobox').map((trigger) => trigger.querySelector('[data-slot="select-value"]')?.textContent ?? '')
}

describe('TicketForm', () => {
  it('starts at the Medium priority and the General category, shown by the names of the reference data', () => {
    render(<TicketForm priorityValues={PRIORITY_VALUES} categoryValues={CATEGORY_VALUES} />)

    expect(selectValues()).toEqual(['Medium', 'General'])
  })

  it('offers the priorities by their names and shows the chosen one by its name', async () => {
    render(<TicketForm priorityValues={PRIORITY_VALUES} categoryValues={CATEGORY_VALUES} />)

    await userEvent.click(screen.getAllByRole('combobox')[0])
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['Low', 'Medium', 'High', 'Urgent'])
    await userEvent.click(screen.getByRole('option', { name: 'Urgent' }))

    expect(selectValues()).toEqual(['Urgent', 'General'])
  })
})
