'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { revalidatePath } from 'next/cache'
import { deleteMessageSchema } from '../lib/support.schema'
import { db } from '@/shared/lib/db'
import { canManageTicket } from '../lib/support-permissions'
import { ForbiddenError } from '@/shared/lib/errors'

export const deleteMessage = safeAction(
  'deleteMessage',
  deleteMessageSchema,
  async (data, user) => {
    const msg = await db.supportMessage.findUnique({
      where: { id: data.id },
      include: {
        ticket: {
          select: { tenantId: true, createdByUserId: true, assignedToUserId: true },
        },
      },
    })
    if (!msg) throw new ForbiddenError()
    if (!canManageTicket(user, msg.ticket)) throw new ForbiddenError()
    const updated = await db.supportMessage.update({
      where: { id: data.id },
      data: {
        bodyRich: '<p><em>[mesaj silindi]</em></p>',
        bodyPlain: '[mesaj silindi]',
        editedAt: new Date(),
      },
    })
    revalidatePath(`/support/${msg.ticketId}`)
    return updated
  },
)
