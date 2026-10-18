import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Row = Record<string, unknown>
type Where = Record<string, unknown>

// The caller, bob, whose session the action reads.
const caller = vi.hoisted(() => ({
  id: 'user-bob',
  email: 'bob@acme.test',
  name: 'Bob',
  currentTenantId: 'tenant-1',
  membershipId: 'member-bob',
  roles: ['TENANT_VIEWER'],
  permissions: [] as string[],
  accessibleTenants: [],
}))

// An in-memory stand-in for the notifications table that honours the where clause of each write. Like Prisma, update
// throws when no row matches, and updateMany answers how many rows it changed.
const { db, tables } = vi.hoisted(() => {
  const tables: { notification: Row[] } = { notification: [] }
  const matches = (row: Row, where: Where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const db = {
    notification: {
      update: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const row = tables.notification.find((candidate) => matches(candidate, where))
        if (!row) throw new Error('No record was found for an update.')
        Object.assign(row, data)
        return { ...row }
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const rows = tables.notification.filter((row) => matches(row, where))
        for (const row of rows) Object.assign(row, data)
        return { count: rows.length }
      }),
    },
  }
  return { db, tables }
})

vi.mock('@/shared/lib/db', () => ({ db }))

vi.mock('@/shared/lib/auth-utils', () => ({
  getCurrentUser: vi.fn().mockResolvedValue(caller),
}))

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { markNotificationRead } from './mark-read'

function notification(id: string, userId: string): Row {
  return { id, userId, tenantId: 'tenant-1', type: 'INFO', title: 'Ticket updated', message: 'A reply arrived', read: false }
}

/** Whether each notification is read, by id. */
function readById(): Record<string, unknown> {
  return Object.fromEntries(tables.notification.map((row) => [row.id, row.read]))
}

beforeEach(() => {
  tables.notification = [notification('notification-alice', 'user-alice'), notification('notification-bob', 'user-bob')]
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('markNotificationRead', () => {
  it('leaves a notification of another user unread and answers not found', async () => {
    const result = await markNotificationRead({ id: 'notification-alice' })

    expect(readById()).toEqual({ 'notification-alice': false, 'notification-bob': false })
    expect(result).toEqual({ success: false, error: 'Notification not found' })
  })

  it('marks a notification of the caller as read', async () => {
    const result = await markNotificationRead({ id: 'notification-bob' })

    expect(result).toEqual({ success: true, data: { success: true } })
    expect(readById()).toEqual({ 'notification-alice': false, 'notification-bob': true })
  })
})
