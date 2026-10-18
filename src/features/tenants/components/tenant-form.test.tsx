import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
// The form's Server Actions import the database client; rendering the form and choosing a plan runs neither.
vi.mock('../actions/create-tenant', () => ({ createTenant: vi.fn() }))
vi.mock('../actions/update-tenant', () => ({ updateTenant: vi.fn() }))

import { TenantForm } from './tenant-form'

const PLANS = [
  { id: 'plan-free', code: 'FREE', name: 'Free' },
  { id: 'plan-team', code: 'TEAM', name: 'Team' },
]

/** The value that the form's plan select shows. */
function planValue(): string {
  return screen.getByRole('combobox').querySelector('[data-slot="select-value"]')?.textContent ?? ''
}

describe('TenantForm', () => {
  it("shows the plan of the tenant it edits by the plan's name, never by its id", () => {
    render(
      <TenantForm
        plans={PLANS}
        tenant={{ id: 'tenant-1', name: 'Acme', slug: 'acme', planConfigId: 'plan-team', active: true }}
      />,
    )

    expect(planValue()).toBe('Team')
  })

  it('shows the plan chosen for a new tenant by its name', async () => {
    render(<TenantForm plans={PLANS} />)
    expect(planValue()).toBe('Select a plan')

    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(await screen.findByRole('option', { name: 'Free' }))

    expect(planValue()).toBe('Free')
  })
})
