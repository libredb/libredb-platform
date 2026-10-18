import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// The member actions import the database client; opening the Change Role dialog runs neither.
vi.mock('../actions/update-user', () => ({ updateUserRole: vi.fn(), toggleUserActive: vi.fn() }))

import { UserList } from './user-list'

const ROLES = [
  { id: 'role-admin', code: 'TENANT_ADMIN', name: 'Tenant Admin' },
  { id: 'role-viewer', code: 'TENANT_VIEWER', name: 'Tenant Viewer' },
]

function member(role: { id: string; code: string; name: string }) {
  return {
    id: 'membership-1',
    user: { id: 'user-1', email: 'sarah.chen@acme.com', name: 'Sarah Chen', active: true, lastLoginAt: null },
    roles: [{ role }],
  }
}

/** Opens the actions menu of the only member, as a click on its trigger does, and returns the menu. */
async function openActions(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
  return screen.findByRole('menu')
}

/** Opens the Change Role dialog of the only member and returns the value that its role select shows. */
async function changeRoleValue(): Promise<string> {
  await userEvent.click(within(await openActions()).getByRole('menuitem', { name: 'Change Role' }))
  const role = within(await screen.findByRole('dialog')).getByRole('combobox')
  return role.querySelector('[data-slot="select-value"]')?.textContent ?? ''
}

describe('UserList', () => {
  // Base UI throws when a group label renders outside its group, and the page then shows only its error screen.
  it("opens a member's actions menu, whose Actions label names the group of its items", async () => {
    render(<UserList members={[member(ROLES[1])]} roles={ROLES} canEdit />)

    const actions = within(await openActions()).getByRole('group', { name: 'Actions' })
    expect(within(actions).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Change Role', 'Deactivate'])
  })

  it("shows the member's role in the Change Role dialog by the role's name, never by its id", async () => {
    render(<UserList members={[member(ROLES[1])]} roles={ROLES} canEdit />)

    expect(await changeRoleValue()).toBe('Tenant Viewer')
  })

  it('shows a role that the tenant cannot assign, such as the platform admin role, by its name without offering it', async () => {
    render(
      <UserList
        members={[member({ id: 'role-platform-admin', code: 'PLATFORM_ADMIN', name: 'Platform Admin' })]}
        roles={ROLES}
        canEdit
      />,
    )

    expect(await changeRoleValue()).toBe('Platform Admin')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('combobox'))
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Tenant Admin',
      'Tenant Viewer',
    ])
  })
})
