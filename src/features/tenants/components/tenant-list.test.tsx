import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../actions/update-tenant', () => ({ updateTenant: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { TenantList, type TenantListItem } from './tenant-list'

const WITHOUT_PLAN: TenantListItem = {
  id: 'tenant-1',
  name: 'Acme',
  slug: 'acme',
  active: true,
  createdAt: '2026-10-15T12:00:00.000Z',
  planConfig: null,
  _count: { members: 2, connections: 1 },
}

describe('TenantList', () => {
  it('shows a hyphen in the Plan column of a tenant without a plan', () => {
    render(<TenantList tenants={[WITHOUT_PLAN]} />)

    const plan = screen.getAllByRole('columnheader').findIndex(header => header.textContent === 'Plan')
    expect(plan).toBeGreaterThan(-1)
    const row = screen.getByText('Acme').closest('tr')
    expect(row).not.toBeNull()
    expect(within(row!).getAllByRole('cell')[plan]).toHaveTextContent(/^-$/)
  })
})
