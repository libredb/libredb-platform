'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { revalidatePath } from 'next/cache'
import { reopenTicketSchema } from '../lib/support.schema'
import { db } from '@/shared/lib/db'
import { canReopenTicket } from '../lib/support-permissions'
import { emitActivity } from '../lib/support-activity'
import { ForbiddenError } from '@/shared/lib/errors'

export const reopenTicket = safeAction(
  'reopenTicket',
  reopenTicketSchema,
  async (data, user) => {
    const ticket = await db.supportTicket.findUnique({ where: { id: data.id } })
    if (!ticket) throw new ForbiddenError()
    if (!canReopenTicket(user, ticket)) throw new ForbiddenError()
    if (ticket.status !== 'RESOLVED' && ticket.status !== 'CLOSED') return ticket

    const updated = await db.$transaction(async (tx) => {
      const t = await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status: 'OPEN',
          reopenedCount: { increment: 1 },
          lastActivityAt: new Date(),
          resolvedAt: null,
          closedAt: null,
        },
      })
      await emitActivity(tx, { ticketId: ticket.id, actorUserId: user.id, type: 'REOPENED' })
      return t
    })

    revalidatePath(`/support/${ticket.id}`)
    return updated
  },
)
