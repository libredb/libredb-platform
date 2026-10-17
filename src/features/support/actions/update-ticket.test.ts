import { describe, expect, it, vi } from 'vitest'

const staff = vi.hoisted(() => ({
  id: 'user-support',
  email: 'support@libredb.test',
  name: 'Support',
  authProvider: 'credentials' as const,
  currentTenantId: null,
  membershipId: null,
  roles: ['PLATFORM_SUPPORT'],
  permissions: ['ticket.view.all', 'ticket.manage'],
  accessibleTenants: [],
  directoryDegraded: false,
}))

// The client inside the one $transaction records what the action writes there.
const { db, tx } = vi.hoisted(() => {
  const tx = {
    supportTicket: { update: vi.fn(async () => ({ id: 'ticket-1' })) },
    supportActivity: { create: vi.fn(async () => ({})) },
    notification: { create: vi.fn(async () => ({})) },
  }
  const db = {
    supportTicket: { findUnique: vi.fn() },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  }
  return { db, tx }
})

vi.mock('@/shared/lib/db', () => ({ db }))
vi.mock('@/shared/lib/auth-utils', () => ({ getCurrentUser: vi.fn().mockResolvedValue(staff) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { updateTicket } from './update-ticket'

describe('updateTicket', () => {
  it('notifies the creator of a resolved ticket with its subject and the rating prompt, a middle dot between them', async () => {
    db.supportTicket.findUnique.mockResolvedValue({
      id: 'ticket-1',
      tenantId: 'tenant-1',
      createdByUserId: 'user-creator',
      assignedToUserId: null,
      status: 'OPEN',
      priority: 'MEDIUM',
      category: 'GENERAL',
      subject: 'Cannot reach the orders database',
    })

    const result = await updateTicket({ id: 'ticket-1', status: 'RESOLVED' })

    expect(result.success).toBe(true)
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-creator',
        type: 'TICKET_RESOLVED',
        message: 'Cannot reach the orders database · 1-5 yıldız değerlendirebilirsiniz.',
      }),
    })
  })
})
