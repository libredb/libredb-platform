import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuditLogTable, type AuditEventRow } from './audit-log-table'

function event(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    eventId: '0192f0c4-0000-7000-8000-000000000001',
    startedAt: '2026-10-15T09:30:00.000Z',
    subject: 'f:ldap:alice',
    username: 'alice',
    connectionId: 'conn-1',
    connectionKnown: true,
    connectionName: 'Orders',
    engine: 'postgres',
    source: 'editor',
    statementType: 'SELECT',
    statementCapture: 'redacted',
    statement: 'SELECT id FROM orders WHERE id = ?',
    statementTruncated: false,
    rowCount: 3,
    durationMs: 12,
    status: 'success',
    errorMessage: null,
    transactionOutcome: null,
    ...overrides,
  }
}

function renderTable(events: AuditEventRow[]) {
  return render(
    <AuditLogTable
      initialEvents={events}
      initialTotal={events.length}
      subjects={[{ subject: 'f:ldap:alice', username: 'alice' }]}
      connections={[{ id: 'conn-1', name: 'Orders', engine: 'postgres' }]}
      stats={{ total: events.length, today: events.length, errors: 0 }}
    />,
  )
}

/** The value that the filter select at `index` shows, in the order User, Connection, Source, Type, Status. */
function filterValue(index: number): string {
  return screen.getAllByRole('combobox')[index].querySelector('[data-slot="select-value"]')?.textContent ?? ''
}

async function chooseFilter(index: number, option: string) {
  await userEvent.click(screen.getAllByRole('combobox')[index])
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

describe('AuditLogTable', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the chosen user and connection filters by the names their options show, never by the subject or the id', async () => {
    renderTable([event()])
    expect([filterValue(0), filterValue(1)]).toEqual(['All Users', 'All Connections'])

    await chooseFilter(0, 'alice')
    await chooseFilter(1, 'Orders')

    expect([filterValue(0), filterValue(1)]).toEqual(['alice', 'Orders'])
  })

  it('shows not captured when the statement is null', () => {
    renderTable([event({ statementCapture: 'none', statement: null })])

    expect(screen.getByText('not captured')).toBeInTheDocument()
    expect(screen.queryByText('SELECT id FROM orders WHERE id = ?')).not.toBeInTheDocument()
  })

  it('renders an unknown source verbatim', () => {
    renderTable([event({ source: 'future-source' })])

    expect(screen.getByText('future-source')).toBeInTheDocument()
  })

  it('shows the username with the subject as its tooltip, the engine, the transaction outcome and the error text', () => {
    renderTable([
      event({
        source: 'transaction',
        status: 'error',
        transactionOutcome: 'rolled-back',
        statementCapture: 'full',
        errorMessage: 'deadlock detected',
      }),
    ])

    expect(screen.getByText('alice')).toHaveAttribute('title', 'f:ldap:alice')
    expect(screen.getByText('(postgres)')).toBeInTheDocument()
    expect(screen.getByText('rolled-back')).toBeInTheDocument()
    expect(screen.getByText('deadlock detected')).toBeInTheDocument()
  })

  it('shows an error banner when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 500 })))
    renderTable([event()])

    await userEvent.click(screen.getByRole('button', { name: 'Filter' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Database unavailable'))
    // The rows already shown stay visible.
    expect(screen.getByText('SELECT id FROM orders WHERE id = ?')).toBeInTheDocument()
  })

  it('shows an error banner when the request does not complete', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderTable([event()])

    await userEvent.click(screen.getByRole('button', { name: 'Filter' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch'))
  })
})
