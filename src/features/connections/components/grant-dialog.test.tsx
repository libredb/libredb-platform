import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LicenseLimitError } from '@/shared/lib/errors'

// dave, a user of the directory who holds no user seat yet.
const DAVE = vi.hoisted(() => ({
  id: '00000000-0000-4000-8000-00000000da7e',
  username: 'dave',
  email: 'dave@libredb.test',
  firstName: null,
  lastName: null,
  enabled: true,
  studioRole: 'user' as const,
  needsSeat: true,
}))
const setConnectionGrant = vi.hoisted(() => vi.fn())
const searchDirectoryUsers = vi.hoisted(() =>
  vi.fn(async (_input: { search?: string; page?: number }) => ({
    success: true as const,
    data: { page: 1, total: 1, users: [DAVE] },
  })),
)

vi.mock('../actions/set-connection-grant', () => ({ setConnectionGrant }))
vi.mock('../actions/search-directory-users', () => ({ searchDirectoryUsers }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { toast } from 'sonner'
import { GrantDialog } from './grant-dialog'

afterEach(() => {
  vi.clearAllMocks()
})

describe('GrantDialog', () => {
  it.each(['LICENSE_USER_SEATS', 'LICENSE_EXPIRED', 'LICENSE_INVALID'] as const)(
    'shows the exact text of the %s refusal of a new grant and stays open',
    async (code) => {
      // safeAction answers a write that the license refuses with the message of its LicenseLimitError, as
      // set-connection-grant.test.ts shows.
      const refusal = new LicenseLimitError(code).message
      setConnectionGrant.mockResolvedValue({ success: false, error: refusal })
      const onClose = vi.fn()
      const user = userEvent.setup()
      render(<GrantDialog connectionId="connection-1" hasWriteCredential target={{ kind: 'new' }} onClose={onClose} />)

      const dialog = await screen.findByRole('dialog')
      await user.click(await within(dialog).findByRole('radio', { name: /dave/ }))
      await user.click(within(dialog).getByRole('button', { name: 'Grant' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith(refusal))
      expect(setConnectionGrant).toHaveBeenCalledExactlyOnceWith({
        connectionId: 'connection-1',
        subject: DAVE.id,
        level: 'read',
        expiresAt: null,
      })
      expect(toast.success).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    },
  )
})
