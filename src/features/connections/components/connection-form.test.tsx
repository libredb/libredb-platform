import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))
vi.mock('../actions/create-database-connection', () => ({ createDatabaseConnection: vi.fn() }))
vi.mock('../actions/update-database-connection', () => ({ updateDatabaseConnection: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { toast } from 'sonner'
import { LicenseLimitError } from '@/shared/lib/errors'
import { ConnectionForm, type ConnectionFormConnection } from './connection-form'
import { createDatabaseConnection } from '../actions/create-database-connection'
import { updateDatabaseConnection } from '../actions/update-database-connection'
import { ENGINE_IDS, ENGINES } from '../lib/engines'

// Studio's contract manifest, vendored by scripts/vendor-studio-governance.mjs.
const MANIFEST_FILE = path.resolve(__dirname, '../../../../tests/fixtures/governance/contract-v1.json')

interface Manifest {
  definitionAllowlist: { path: string; domain: { type: string; enum?: string[] } }[]
}

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))

const STORED: ConnectionFormConnection = {
  id: '0192f0c4-0000-7000-8000-0000000000aa',
  name: 'Orders',
  engine: 'postgres',
  environment: 'production',
  groupName: 'Sales',
  definition: { host: 'db.internal', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } },
  active: true,
  hasWriteCredential: true,
}

function group(name: string): HTMLElement {
  return screen.getByRole('group', { name })
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^(Create connection|Save changes)$/ }) as HTMLButtonElement
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('ConnectionForm', () => {
  it('never renders a stored credential', () => {
    // A connection object that carries more than the form takes, as a careless caller might pass it.
    const leaky = {
      ...STORED,
      readSecret: 'lsb1.STORED-READ-ENVELOPE',
      writeSecret: 'lsb1.STORED-WRITE-ENVELOPE',
      user: 'stored_user',
      password: 'stored-password',
    } as ConnectionFormConnection
    const { container } = render(<ConnectionForm connection={leaky} />)

    const read = group('Read credential')
    expect((within(read).getByLabelText('User') as HTMLInputElement).value).toBe('')
    expect((within(read).getByLabelText('Password') as HTMLInputElement).value).toBe('')
    for (const input of container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
      expect(input.value).not.toMatch(/stored|lsb1\./)
    }
    expect(container.innerHTML).not.toMatch(/STORED-READ-ENVELOPE|STORED-WRITE-ENVELOPE|stored_user|stored-password/)
    // The stored definition is shown, since it holds no secret.
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('db.internal')
  })

  it('asks for credentials again when the definition changes', async () => {
    const user = userEvent.setup()
    vi.mocked(updateDatabaseConnection).mockResolvedValue({ success: true, data: { id: STORED.id } })
    render(<ConnectionForm connection={STORED} />)

    // Unchanged, the stored credentials stay: no credential is asked for.
    expect(screen.queryByText(/enter the read credential again/i)).toBeNull()

    await user.clear(screen.getByLabelText('Host'))
    await user.type(screen.getByLabelText('Host'), 'db2.internal')
    expect(screen.getByText(/enter the read credential again/i)).toBeInTheDocument()

    await user.click(screen.getByLabelText(/I confirm that the read credential can only read/))
    await user.click(submitButton())
    expect(updateDatabaseConnection).not.toHaveBeenCalled()
    expect(within(group('Read credential')).getByText('A changed engine or definition needs the read credential again')).toBeInTheDocument()
    expect(screen.getByText('A changed engine or definition needs the write credential again, or its removal')).toBeInTheDocument()

    const read = group('Read credential')
    await user.type(within(read).getByLabelText('User'), 'libredb_read')
    await user.type(within(read).getByLabelText('Password'), 'read-secret')
    await user.selectOptions(screen.getByLabelText('Write credential'), 'remove')
    await user.click(submitButton())

    await waitFor(() => expect(updateDatabaseConnection).toHaveBeenCalledTimes(1))
    expect(vi.mocked(updateDatabaseConnection).mock.calls[0][0]).toEqual({
      id: STORED.id,
      name: 'Orders',
      environment: 'production',
      groupName: 'Sales',
      active: true,
      definition: { host: 'db2.internal', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } },
      readCredential: { user: 'libredb_read', password: 'read-secret' },
      removeWriteCredential: true,
      readOnlyConfirmed: true,
    })
  })

  it("shows the engine's least-privilege SQL and blocks submit until it is confirmed", async () => {
    const user = userEvent.setup()
    vi.mocked(createDatabaseConnection).mockResolvedValue({ success: true, data: { id: 'new-id' } })
    render(<ConnectionForm />)

    for (const engine of ENGINE_IDS) {
      await user.selectOptions(screen.getByLabelText('Engine'), engine)
      expect(screen.getByTestId('least-privilege-sql').textContent).toBe(ENGINES[engine].guidance.statements)
      for (const note of ENGINES[engine].guidance.notes) expect(screen.getByText(note)).toBeInTheDocument()
    }
    await user.selectOptions(screen.getByLabelText('Engine'), 'postgres')

    await user.type(screen.getByLabelText('Name'), 'Orders')
    await user.type(screen.getByLabelText('Host'), 'db.internal')
    await user.type(screen.getByLabelText('Database'), 'orders')
    const read = group('Read credential')
    await user.type(within(read).getByLabelText('User'), 'libredb_read')
    await user.type(within(read).getByLabelText('Password'), 'read-secret')

    expect(submitButton().disabled).toBe(true)
    await user.click(submitButton())
    expect(createDatabaseConnection).not.toHaveBeenCalled()

    await user.click(screen.getByLabelText(/I confirm that the read credential can only read/))
    expect(submitButton().disabled).toBe(false)
    await user.click(submitButton())

    await waitFor(() => expect(createDatabaseConnection).toHaveBeenCalledTimes(1))
    expect(vi.mocked(createDatabaseConnection).mock.calls[0][0]).toEqual({
      engine: 'postgres',
      name: 'Orders',
      definition: { host: 'db.internal', database: 'orders' },
      readCredential: { user: 'libredb_read', password: 'read-secret' },
      readOnlyConfirmed: true,
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/connections'))
  })

  it.each(['LICENSE_USER_SEATS', 'LICENSE_EXPIRED'] as const)(
    'shows the exact text of the %s refusal of a new connection and stays on the form',
    async (code) => {
      // safeAction answers a write that the license refuses with the message of its LicenseLimitError, as
      // create-database-connection.test.ts shows.
      const refusal = new LicenseLimitError(code).message
      vi.mocked(createDatabaseConnection).mockResolvedValue({ success: false, error: refusal })
      const user = userEvent.setup()
      render(<ConnectionForm />)

      await user.type(screen.getByLabelText('Name'), 'Orders')
      await user.type(screen.getByLabelText('Host'), 'db.internal')
      await user.type(screen.getByLabelText('Database'), 'orders')
      const read = group('Read credential')
      await user.type(within(read).getByLabelText('User'), 'libredb_read')
      await user.type(within(read).getByLabelText('Password'), 'read-secret')
      await user.click(screen.getByLabelText(/I confirm that the read credential can only read/))
      await user.click(submitButton())

      await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith(refusal))
      expect(createDatabaseConnection).toHaveBeenCalledTimes(1)
      expect(toast.success).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
    },
  )

  it('offers only the ssl.mode values of the vendored allowlist', async () => {
    const user = userEvent.setup()
    const allowed = manifest.definitionAllowlist.find((entry) => entry.path === 'ssl.mode')?.domain.enum
    expect(allowed?.length).toBeGreaterThan(0)
    render(<ConnectionForm />)

    for (const engine of ENGINE_IDS) {
      await user.selectOptions(screen.getByLabelText('Engine'), engine)
      const options = [...(screen.getByLabelText('SSL mode') as HTMLSelectElement).options]
      // The empty choice leaves ssl out of the definition.
      expect(options[0].value).toBe('')
      expect(options.slice(1).map((option) => option.value)).toEqual(allowed)
    }
  })
})
