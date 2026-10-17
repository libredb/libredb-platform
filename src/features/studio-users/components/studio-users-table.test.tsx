import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const revokeStudioSessions = vi.hoisted(() => vi.fn(async (_input: { subject: string }) => ({ success: true as const, data: { id: 'revocation-1' } })))

vi.mock('../actions/revoke-studio-sessions', () => ({ revokeStudioSessions }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { StudioUsersTable } from './studio-users-table'
import type { StudioUser, StudioUsersPage } from '../lib/studio-users'

const ALICE: StudioUser = {
  id: '00000000-0000-4000-8000-00000000a11c',
  username: 'alice',
  email: 'alice@libredb.test',
  name: 'Alice Admin',
  enabled: true,
  roles: ['admin', 'user'],
}
const BOB: StudioUser = {
  id: '00000000-0000-4000-8000-000000000b0b',
  username: 'bob',
  email: null,
  name: null,
  enabled: true,
  roles: ['user'],
}
const FRANK: StudioUser = {
  id: '00000000-0000-4000-8000-00000000f4a2',
  username: 'frank',
  email: 'frank@libredb.test',
  name: null,
  enabled: false,
  roles: ['user'],
}

function pageOf(users: StudioUser[], overrides: Partial<StudioUsersPage> = {}): StudioUsersPage {
  return { users, page: 1, pageCount: 1, total: users.length, ...overrides }
}

function rowOf(username: string): HTMLElement {
  return screen.getByRole('row', { name: new RegExp(`\\b${username}\\b`) })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('StudioUsersTable', () => {
  it('Revoke Studio sessions asks for confirmation and then calls the action with the subject', async () => {
    const user = userEvent.setup()
    render(<StudioUsersTable page={pageOf([ALICE, BOB])} search="" />)

    await user.click(within(rowOf('bob')).getByRole('button', { name: 'Revoke Studio sessions' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Revoke the Studio sessions of bob?')
    expect(revokeStudioSessions).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Revoke sessions' }))

    await waitFor(() => expect(revokeStudioSessions).toHaveBeenCalledWith({ subject: BOB.id }))
    expect(revokeStudioSessions).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('cancelling the confirmation revokes nothing', async () => {
    const user = userEvent.setup()
    render(<StudioUsersTable page={pageOf([ALICE, BOB])} search="" />)

    await user.click(within(rowOf('alice')).getByRole('button', { name: 'Revoke Studio sessions' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(revokeStudioSessions).not.toHaveBeenCalled()
  })

  it('shows the role badges, the email or a dash, and the disabled flag', () => {
    render(<StudioUsersTable page={pageOf([ALICE, BOB, FRANK])} search="" />)

    const alice = rowOf('alice')
    expect(within(alice).getByText('Alice Admin')).toBeInTheDocument()
    expect(within(alice).getByText('alice@libredb.test')).toBeInTheDocument()
    expect(within(alice).getByText('Admin')).toBeInTheDocument()
    expect(within(alice).getByText('User')).toBeInTheDocument()
    expect(within(alice).getByText('Enabled')).toBeInTheDocument()

    const bob = rowOf('bob')
    expect(within(bob).queryByText('Admin')).not.toBeInTheDocument()
    expect(within(bob).getByText('User')).toBeInTheDocument()
    expect(within(bob).getByText('-')).toBeInTheDocument()

    expect(within(rowOf('frank')).getByText('Disabled')).toBeInTheDocument()
  })

  it('keeps the search in the pagination links and offers only the pages that exist', () => {
    const { rerender } = render(<StudioUsersTable page={pageOf([ALICE], { page: 2, pageCount: 3, total: 41 })} search="a b" />)

    expect(screen.getByRole('searchbox', { name: 'Search Studio users' })).toHaveValue('a b')
    expect(screen.getByText('Page 2 of 3, 41 users')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/studio-users?q=a+b&page=1')
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/studio-users?q=a+b&page=3')

    rerender(<StudioUsersTable page={pageOf([ALICE], { page: 1, pageCount: 1, total: 1 })} search="" />)

    expect(screen.queryByRole('link', { name: 'Previous page' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Next page' })).not.toBeInTheDocument()
    expect(screen.getByText('Page 1 of 1, 1 user')).toBeInTheDocument()
  })

  it('says so when no user matches the search', () => {
    render(<StudioUsersTable page={pageOf([], { total: 0 })} search="nobody" />)

    expect(screen.getByText('No Studio user matches nobody.')).toBeInTheDocument()
  })
})
