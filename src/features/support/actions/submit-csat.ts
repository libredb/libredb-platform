'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { revalidatePath } from 'next/cache'
import { submitCsatSchema } from '../lib/support.schema'
import { db } from '@/shared/lib/db'
import { emitActivity } from '../lib/support-activity'
import { ForbiddenError } from '@/shared/lib/errors'

export const submitCsat = safeAction(
  'submitCsat',
  submitCsatSchema,
  async (data, user) => {
    const ticket = await db.supportTicket.findUnique({ where: { id: data.ticketId } })
    if (!ticket) throw new ForbiddenError()
    if (ticket.createdByUserId !== user.id) throw new ForbiddenError()
    if (ticket.satisfactionRating !== null) throw new ForbiddenError()
    if (ticket.status !== 'RESOLVED' && ticket.status !== 'CLOSED') throw new ForbiddenError()

    await db.$transaction(async (tx) => {
      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          satisfactionRating: data.rating,
          satisfactionComment: data.comment ?? null,
          satisfactionAt: new Date(),
          lastActivityAt: new Date(),
        },
      })
      await emitActivity(tx, {
        ticketId: ticket.id,
        actorUserId: user.id,
        type: 'CSAT_RECEIVED',
        metadata: { rating: data.rating },
      })
      if (ticket.assignedToUserId && ticket.assignedToUserId !== user.id) {
        await tx.notification.create({
          data: {
            userId: ticket.assignedToUserId,
            tenantId: ticket.tenantId,
            type: 'CSAT',
            title: `Customer gave ${data.rating}/5 stars`,
            message: data.comment?.slice(0, 140) ?? '',
            link: `/support/${ticket.id}`,
          },
        })
      }
    })

    revalidatePath(`/support/${ticket.id}`)
  },
)
