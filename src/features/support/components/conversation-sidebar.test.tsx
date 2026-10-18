import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConversationSidebar } from './conversation-sidebar'

const STATUS_VALUES = [
  { code: 'OPEN', name: 'Open', colorCode: null },
  { code: 'RESOLVED', name: 'Resolved', colorCode: null },
]
const PRIORITY_VALUES = [
  { code: 'MEDIUM', name: 'Medium', colorCode: null },
  { code: 'URGENT', name: 'Urgent', colorCode: null },
]
const CATEGORY_VALUES = [
  { code: 'GENERAL', name: 'General', colorCode: null },
  { code: 'TECHNICAL', name: 'Technical', colorCode: null },
]
const MEMBERS = [
  { userId: 'user-agent', userName: 'Ayse Yilmaz' },
  { userId: 'user-other', userName: 'Tom Reed' },
]

function renderSidebar(ticket: Record<string, unknown>, userMap: Record<string, string> = {}) {
  return render(
    <ConversationSidebar
      ticket={{
        status: 'OPEN',
        priority: 'URGENT',
        category: 'TECHNICAL',
        assignedToUserId: 'user-agent',
        createdAt: '2026-10-18T09:00:00.000Z',
        firstResponseAt: null,
        resolvedAt: null,
        reopenedCount: 0,
        ...ticket,
      }}
      canManage
      statusValues={STATUS_VALUES}
      priorityValues={PRIORITY_VALUES}
      categoryValues={CATEGORY_VALUES}
      members={MEMBERS}
      userMap={userMap}
      tags={[]}
      availableTags={[]}
      onStatusChange={vi.fn()}
      onPriorityChange={vi.fn()}
      onCategoryChange={vi.fn()}
      onAssigneeChange={vi.fn()}
      onTagAdd={vi.fn()}
      onTagRemove={vi.fn()}
      customerName="Sarah Chen"
      customerEmail="sarah.chen@acme.test"
      tenantName="Acme"
      tenantSlug="acme"
      tenantPlan={null}
    />,
  )
}

/** The value each select of the sidebar shows, in the order Assigned To, Status, Priority, Category. */
function selectValues(): string[] {
  return screen.getAllByRole('combobox').map((trigger) => trigger.querySelector('[data-slot="select-value"]')?.textContent ?? '')
}

describe('ConversationSidebar', () => {
  it('shows the assignee, status, priority and category by the names their options show', () => {
    renderSidebar({})

    expect(selectValues()).toEqual(['Ayse Yilmaz', 'Open', 'Urgent', 'Technical'])
  })

  it('shows an unassigned ticket as Unassigned', () => {
    renderSidebar({ assignedToUserId: null })

    expect(selectValues()[0]).toBe('Unassigned')
  })

  it('shows an assignee missing from the staff options by the name the ticket page knows', () => {
    renderSidebar({ assignedToUserId: 'user-former' }, { 'user-former': 'Lisa Zhang' })

    expect(selectValues()[0]).toBe('Lisa Zhang')
  })

  it('shows an assignee whose name nobody knows as Unknown user, never as the user id', () => {
    renderSidebar({ assignedToUserId: 'user-deleted' })

    expect(selectValues()[0]).toBe('Unknown user')
  })

  it('shows a status the reference data does not list by its code, as the ticket header does', () => {
    renderSidebar({ status: 'ON_HOLD' })

    expect(selectValues()[1]).toBe('ON_HOLD')
  })

  it('names each select after the label above it', () => {
    renderSidebar({})

    expect(screen.getByRole('combobox', { name: 'Assigned To' })).toHaveTextContent('Ayse Yilmaz')
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Open')
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveTextContent('Urgent')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('Technical')
  })
})
