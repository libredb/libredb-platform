'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { revalidatePath } from 'next/cache'
import { addTagSchema } from '../lib/support.schema'
import { db } from '@/shared/lib/db'
import { canManageTicket } from '../lib/support-permissions'
import { emitActivity } from '../lib/support-activity'
import { ForbiddenError } from '@/shared/lib/errors'

export const addTag = safeAction(
  'addTag',
  addTagSchema,
  async (data, user) => {
    const ticket = await db.supportTicket.findUnique({ where: { id: data.ticketId } })
    if (!ticket) throw new ForbiddenError()
    if (!canManageTicket(user, ticket)) throw new ForbiddenError()

    const tag = await db.supportTag.findUnique({ where: { id: data.tagId } })
    if (!tag) throw new ForbiddenError()

    await db.$transaction(async (tx) => {
      await tx.supportTicketTag.create({
        data: { ticketId: data.ticketId, tagId: data.tagId, createdByUserId: user.id },
      })
      await emitActivity(tx, {
        ticketId: data.ticketId,
        actorUserId: user.id,
        type: 'TAG_ADDED',
        metadata: { tagId: tag.id, tagName: tag.name, tagColor: tag.colorCode },
      })
      await tx.supportTicket.update({
        where: { id: data.ticketId },
        data: { lastActivityAt: new Date() },
      })
    })
    revalidatePath(`/support/${data.ticketId}`)
  },
)
