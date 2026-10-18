import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// The member actions import the database client; opening the Change Role dialog runs neither.
vi.mock('../actions/update-user', () => ({ updateUserRole: vi.fn(), toggleUserActive: vi.fn() }))
// The actions menu renders its items in place as buttons, so one click opens the Change Role dialog that these tests
// cover; Base UI's menu is not what they test.
vi.mock('@/shared/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuLabel: () => null,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

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

/** Opens the Change Role dialog of the only member and returns the value that its role select shows. */
async function changeRoleValue(): Promise<string> {
  await userEvent.click(screen.getByRole('button', { name: /Change Role/ }))
  const role = within(await screen.findByRole('dialog')).getByRole('combobox')
  return role.querySelector('[data-slot="select-value"]')?.textContent ?? ''
}

describe('UserList', () => {
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
