import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const setConnectionGrant = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ success: true as const, data: { id: 'grant-new' } })))
const revokeConnectionGrant = vi.hoisted(() =>
  vi.fn(async (input: { grantId: string }) => ({ success: true as const, data: { id: input.grantId } })),
)
// The directory search answers bob, who holds a user seat, unless a test adds users.
const directoryUsers = vi.hoisted(() => ({
  extra: [] as Array<{
    id: string
    username: string
    email: string | null
    firstName: string | null
    lastName: string | null
    enabled: boolean
    studioRole: 'admin' | 'user' | null
    needsSeat: boolean
  }>,
}))
const searchDirectoryUsers = vi.hoisted(() =>
  vi.fn(async (_input: { search?: string; page?: number }) => ({
    success: true as const,
    data: {
      page: 1,
      total: 1 + directoryUsers.extra.length,
      users: [
        {
          id: '00000000-0000-4000-8000-000000000b0b',
          username: 'bob',
          email: 'bob@libredb.test',
          firstName: null,
          lastName: null,
          enabled: true,
          studioRole: 'user' as const,
          needsSeat: false,
        },
        ...directoryUsers.extra,
      ],
    },
  })),
)

vi.mock('../actions/set-connection-grant', () => ({ setConnectionGrant }))
vi.mock('../actions/revoke-connection-grant', () => ({ revokeConnectionGrant }))
vi.mock('../actions/search-directory-users', () => ({ searchDirectoryUsers }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ConnectionAccessPanel } from './connection-access-panel'
import type { ConnectionAccess, ConnectionAccessGrant } from '../lib/grant.schema'

const CONNECTION_ID = 'connection-1'

const BOB_GRANT: ConnectionAccessGrant = {
  id: 'grant-bob',
  subject: '00000000-0000-4000-8000-000000000b0b',
  username: 'bob',
  email: 'bob@libredb.test',
  level: 'read',
  downgraded: false,
  expiresAt: null,
  grantedBy: 'Alice Admin',
  grantedAt: '2026-10-15T08:30:00.000Z',
  directory: { status: 'present', studioRole: 'user', enabled: true },
}

const GONE_GRANT: ConnectionAccessGrant = {
  id: 'grant-gone',
  subject: '00000000-0000-4000-8000-00000000dead',
  username: 'zoe',
  email: null,
  level: 'write',
  downgraded: true,
  expiresAt: '2026-12-31T00:00:00.000Z',
  grantedBy: 'alice@libredb.test',
  grantedAt: '2026-10-01T12:00:00.000Z',
  directory: { status: 'missing' },
}

function accessOf(grants: ConnectionAccessGrant[], overrides: Partial<ConnectionAccess> = {}): ConnectionAccess {
  return { directory: 'available', grants, ...overrides }
}

function rowOf(username: string): HTMLElement {
  return screen.getByRole('row', { name: new RegExp(`\\b${username}\\b`) })
}

afterEach(() => {
  vi.clearAllMocks()
  directoryUsers.extra = []
})

describe('ConnectionAccessPanel', () => {
  it('marks subjects missing from the directory', () => {
    render(<ConnectionAccessPanel connectionId={CONNECTION_ID} hasWriteCredential access={accessOf([BOB_GRANT, GONE_GRANT])} />)

    const gone = rowOf('zoe')
    expect(gone).toHaveTextContent('Not in directory')
    expect(gone).toHaveTextContent('Downgraded')
    expect(gone).toHaveTextContent('2026-12-31 00:00 UTC')
    expect(gone).toHaveTextContent('alice@libredb.test')

    const bob = rowOf('bob')
    expect(bob).not.toHaveTextContent('Not in directory')
    expect(bob).toHaveTextContent('User')
    expect(bob).toHaveTextContent('Read')
    expect(bob).toHaveTextContent('Never')
    expect(bob).toHaveTextContent('Alice Admin')
    expect(bob).toHaveTextContent('2026-10-15 08:30 UTC')
  })

  it('disables write when the connection has no write credential', async () => {
    const user = userEvent.setup()
    render(<ConnectionAccessPanel connectionId={CONNECTION_ID} hasWriteCredential={false} access={accessOf([BOB_GRANT])} />)

    await user.click(screen.getByRole('button', { name: 'Grant access' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: 'Write' })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: 'Read' })).toBeChecked()
    expect(dialog).toHaveTextContent('no write credential')

    await user.click(await within(dialog).findByRole('radio', { name: /bob/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Grant' }))

    await waitFor(() =>
      expect(setConnectionGrant).toHaveBeenCalledWith({
        connectionId: CONNECTION_ID,
        subject: BOB_GRANT.subject,
        level: 'read',
        expiresAt: null,
      }),
    )
  })

  it('offers write when the connection has a write credential', async () => {
    const user = userEvent.setup()
    render(<ConnectionAccessPanel connectionId={CONNECTION_ID} hasWriteCredential access={accessOf([BOB_GRANT])} />)

    await user.click(within(rowOf('bob')).getByRole('button', { name: 'Change' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('bob')
    await user.click(within(dialog).getByRole('radio', { name: 'Write' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(setConnectionGrant).toHaveBeenCalledWith({
        connectionId: CONNECTION_ID,
        subject: BOB_GRANT.subject,
        level: 'write',
        expiresAt: null,
      }),
    )
  })

  it('revoke asks for confirmation and then calls revokeConnectionGrant with the grant id', async () => {
    const user = userEvent.setup()
    render(<ConnectionAccessPanel connectionId={CONNECTION_ID} hasWriteCredential access={accessOf([BOB_GRANT, GONE_GRANT])} />)

    await user.click(within(rowOf('bob')).getByRole('button', { name: 'Revoke' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Revoke the access of bob?')
    expect(revokeConnectionGrant).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Revoke access' }))

    await waitFor(() => expect(revokeConnectionGrant).toHaveBeenCalledWith({ grantId: BOB_GRANT.id }))
    expect(revokeConnectionGrant).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps revoke and disables grant and change while the directory cannot be read', () => {
    render(
      <ConnectionAccessPanel
        connectionId={CONNECTION_ID}
        hasWriteCredential
        access={accessOf([{ ...BOB_GRANT, directory: { status: 'unknown' } }], { directory: 'unreachable' })}
      />,
    )

    expect(screen.getByRole('button', { name: 'Grant access' })).toBeDisabled()
    const bob = rowOf('bob')
    expect(within(bob).getByRole('button', { name: 'Change' })).toBeDisabled()
    expect(within(bob).getByRole('button', { name: 'Revoke' })).toBeEnabled()
    expect(bob).toHaveTextContent('Unknown')
  })

  it('marks the directory users who would need a new user seat, and still lets the admin pick them', async () => {
    directoryUsers.extra = [
      {
        id: '00000000-0000-4000-8000-00000000da7e',
        username: 'dave',
        email: 'dave@libredb.test',
        firstName: null,
        lastName: null,
        enabled: true,
        studioRole: 'user',
        needsSeat: true,
      },
    ]
    const user = userEvent.setup()
    render(<ConnectionAccessPanel connectionId={CONNECTION_ID} hasWriteCredential access={accessOf([BOB_GRANT])} />)

    await user.click(screen.getByRole('button', { name: 'Grant access' }))
    const dialog = await screen.findByRole('dialog')
    const dave = await within(dialog).findByRole('radio', { name: /dave/ })
    expect(dave.closest('label')).toHaveTextContent('Needs a seat')
    expect(within(dialog).getByRole('radio', { name: /bob/ }).closest('label')).not.toHaveTextContent('Needs a seat')
    expect(dialog).toHaveTextContent(
      'Users marked Needs a seat hold no user seat yet, and a grant to one takes a seat of the license while the connection is active.',
    )

    await user.click(dave)
    await user.click(within(dialog).getByRole('button', { name: 'Grant' }))
    await waitFor(() =>
      expect(setConnectionGrant).toHaveBeenCalledWith({
        connectionId: CONNECTION_ID,
        subject: '00000000-0000-4000-8000-00000000da7e',
        level: 'read',
        expiresAt: null,
      }),
    )
  })

  it('shows no seat note when every listed user holds a seat', async () => {
    const user = userEvent.setup()
    render(<ConnectionAccessPanel connectionId={CONNECTION_ID} hasWriteCredential access={accessOf([BOB_GRANT])} />)

    await user.click(screen.getByRole('button', { name: 'Grant access' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('radio', { name: /bob/ })
    expect(dialog).not.toHaveTextContent('Needs a seat')
  })

  it('says so when nobody holds a grant', () => {
    render(<ConnectionAccessPanel connectionId={CONNECTION_ID} hasWriteCredential access={accessOf([])} />)
    expect(screen.getByText('No user holds a grant on this connection.')).toBeInTheDocument()
  })
})
