'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { revalidatePath } from 'next/cache'
import { editMessageSchema } from '../lib/support.schema'
import { db } from '@/shared/lib/db'
import { canEditMessage } from '../lib/support-permissions'
import { sanitizeTicketHtml } from '../lib/support-sanitize'
import { ForbiddenError } from '@/shared/lib/errors'

export const editMessage = safeAction(
  'editMessage',
  editMessageSchema,
  async (data, user) => {
    const msg = await db.supportMessage.findUnique({ where: { id: data.id } })
    if (!msg) throw new ForbiddenError()
    if (!canEditMessage(user, msg)) throw new ForbiddenError()
    const updated = await db.supportMessage.update({
      where: { id: data.id },
      data: {
        bodyRich: sanitizeTicketHtml(data.bodyRich),
        bodyPlain: data.bodyPlain,
        editedAt: new Date(),
      },
    })
    revalidatePath(`/support/${msg.ticketId}`)
    return updated
  },
)
