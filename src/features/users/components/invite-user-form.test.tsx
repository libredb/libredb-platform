import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// The invite Server Action imports the database client; choosing a role sends no invitation.
vi.mock('../actions/invite-user', () => ({ inviteUser: vi.fn() }))

import { InviteUserForm } from './invite-user-form'

const ROLES = [
  { id: 'role-admin', code: 'TENANT_ADMIN', name: 'Tenant Admin' },
  { id: 'role-viewer', code: 'TENANT_VIEWER', name: 'Tenant Viewer' },
]

describe('InviteUserForm', () => {
  it("shows the chosen role by the role's name, never by its id", async () => {
    render(<InviteUserForm roles={ROLES} />)
    await userEvent.click(screen.getByRole('button', { name: 'Invite User' }))
    const role = within(screen.getByRole('dialog')).getByRole('combobox')
    expect(role.querySelector('[data-slot="select-value"]')).toHaveTextContent('Select a role')

    await userEvent.click(role)
    await userEvent.click(await screen.findByRole('option', { name: 'Tenant Viewer' }))

    expect(role.querySelector('[data-slot="select-value"]')).toHaveTextContent(/^Tenant Viewer$/)
  })
})
