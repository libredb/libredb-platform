import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TenantOverviewTab, type TenantOverviewData } from './tenant-overview-tab'

function tenant(overrides: Partial<TenantOverviewData> = {}): TenantOverviewData {
  return {
    id: 'tenant-1',
    name: 'Acme',
    slug: 'acme',
    createdAt: '2026-01-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    active: true,
    planConfig: null,
    subscription: null,
    counts: { members: 0, connections: 0, queryEvents: 0, tickets: 0, sharedQueries: 0, invitations: 0 },
    recentActivity: [],
    ...overrides,
  }
}

describe('TenantOverviewTab', () => {
  it('shows the current period as its first and last day joined by the word to', () => {
    // Noon local time, so that the dates read the same in every time zone of the test run.
    const subscription = {
      status: 'active',
      currentPeriodStart: new Date(2026, 2, 1, 12).toISOString(),
      currentPeriodEnd: new Date(2026, 3, 1, 12).toISOString(),
      cancelAtPeriodEnd: false,
      stripeCustomerId: null,
    }

    render(<TenantOverviewTab tenant={tenant({ subscription })} />)

    expect(screen.getByText('Current Period').nextElementSibling).toHaveTextContent(/^Mar 1 to Apr 1, 2026$/)
  })

  it('separates the number and the subject of a ticket in the recent activity with a middle dot', () => {
    const recentActivity = [{
      kind: 'ticket' as const,
      id: 'ticket-1',
      at: '2026-10-15T12:00:00.000Z',
      ticketNumber: 'TKT-0001',
      subject: 'Cannot reach the orders database',
      status: 'OPEN',
      priority: 'HIGH',
    }]

    render(<TenantOverviewTab tenant={tenant({ recentActivity })} />)

    expect(screen.getByText('TKT-0001').parentElement)
      .toHaveTextContent('Ticket TKT-0001 · Cannot reach the orders database')
  })
})
