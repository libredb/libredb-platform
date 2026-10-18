import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConversationHeader } from './conversation-header'

function renderHeader() {
  return render(
    <ConversationHeader
      ticket={{
        id: 'ticket-1',
        ticketNumber: 'TKT-SEED-001',
        subject: 'Database unreachable',
        status: 'OPEN',
        priority: 'URGENT',
        tenantName: 'Acme Corp',
        customerName: 'Sarah Chen',
      }}
      canManage
      statusValues={[{ code: 'OPEN', name: 'Open', colorCode: null }]}
      priorityValues={[{ code: 'URGENT', name: 'Urgent', colorCode: null }]}
      onResolve={vi.fn()}
      onReopen={vi.fn()}
      onUpdateSubject={vi.fn()}
    />,
  )
}

describe('ConversationHeader', () => {
  it('offers an agent Resolve and no menu of actions that the support inbox does not have, such as Merge', async () => {
    renderHeader()

    for (const menu of screen.getAllByRole('button').filter((button) => button.getAttribute('aria-haspopup') === 'menu')) {
      await userEvent.click(menu)
    }

    expect(screen.queryByText(/merge|phase/i)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button').map((button) => button.textContent?.trim())).toEqual(['Resolve'])
  })
})
