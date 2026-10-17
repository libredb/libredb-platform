'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { revalidatePath } from 'next/cache'
import { removeTagSchema } from '../lib/support.schema'
import { db } from '@/shared/lib/db'
import { canManageTicket } from '../lib/support-permissions'
import { emitActivity } from '../lib/support-activity'
import { ForbiddenError } from '@/shared/lib/errors'

export const removeTag = safeAction(
  'removeTag',
  removeTagSchema,
  async (data, user) => {
    const ticket = await db.supportTicket.findUnique({ where: { id: data.ticketId } })
    if (!ticket) throw new ForbiddenError()
    if (!canManageTicket(user, ticket)) throw new ForbiddenError()

    const tag = await db.supportTag.findUnique({ where: { id: data.tagId } })

    await db.$transaction(async (tx) => {
      await tx.supportTicketTag.delete({
        where: { ticketId_tagId: { ticketId: data.ticketId, tagId: data.tagId } },
      })
      if (tag) {
        await emitActivity(tx, {
          ticketId: data.ticketId,
          actorUserId: user.id,
          type: 'TAG_REMOVED',
          metadata: { tagId: tag.id, tagName: tag.name, tagColor: tag.colorCode },
        })
      }
      await tx.supportTicket.update({
        where: { id: data.ticketId },
        data: { lastActivityAt: new Date() },
      })
    })
    revalidatePath(`/support/${data.ticketId}`)
  },
)
