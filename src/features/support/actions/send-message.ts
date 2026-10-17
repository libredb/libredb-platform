'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { revalidatePath } from 'next/cache'
import { sendMessageSchema } from '../lib/support.schema'
import { db } from '@/shared/lib/db'
import { canViewTicket, canSeeInternalNotes } from '../lib/support-permissions'
import { sanitizeTicketHtml } from '../lib/support-sanitize'
import { emitActivity } from '../lib/support-activity'
import { ForbiddenError, LimitExceededError } from '@/shared/lib/errors'
import { PERMISSIONS } from '@/shared/lib/permissions'
import {
  MAX_FILES_PER_MESSAGE,
  MAX_TICKET_BYTES,
} from '../lib/attachment-allowlist'

function extractMentionIds(html: string): string[] {
  const ids = new Set<string>()
  const re = /data-mention-id="([^"]+)"/g
  let m
  while ((m = re.exec(html)) !== null) ids.add(m[1])
  return Array.from(ids)
}

export const sendMessage = safeAction(
  'sendMessage',
  sendMessageSchema,
  async (data, user) => {
    const ticket = await db.supportTicket.findUnique({
      where: { id: data.ticketId },
      select: {
        id: true, tenantId: true, createdByUserId: true,
        assignedToUserId: true, status: true, firstResponseAt: true,
      },
    })
    if (!ticket) throw new ForbiddenError()
    if (!canViewTicket(user, ticket)) throw new ForbiddenError()
    if (data.isInternal && !canSeeInternalNotes(user)) {
      throw new ForbiddenError()
    }

    // Attachment limits: server-side backstop. Client hook (use-attachment-upload)
    // enforces the same bounds for UX, but anyone bypassing the client could
    // attach unlimited files or inflate the per-ticket byte budget, so we must
    // re-check here before persisting anything.
    const attachments = data.attachments ?? []
    if (attachments.length > MAX_FILES_PER_MESSAGE) {
      throw new LimitExceededError('attachments-per-message', MAX_FILES_PER_MESSAGE)
    }
    if (attachments.length > 0) {
      const existingBytes = await db.supportAttachment.aggregate({
        where: { message: { ticketId: data.ticketId } },
        _sum: { fileSize: true },
      })
      const currentBytes = existingBytes._sum.fileSize ?? 0
      const incomingBytes = attachments.reduce((sum, a) => sum + a.fileSize, 0)
      if (currentBytes + incomingBytes > MAX_TICKET_BYTES) {
        throw new LimitExceededError('ticket-total-bytes', MAX_TICKET_BYTES)
      }
    }

    const safeRich = sanitizeTicketHtml(data.bodyRich)
    const mentionIds = data.isInternal ? extractMentionIds(safeRich) : []
    const isPlatformReply = user.permissions.includes(PERMISSIONS.TICKET_MANAGE)
    const isCustomerReply = ticket.createdByUserId === user.id
    const shouldReopen = isCustomerReply && (ticket.status === 'RESOLVED' || ticket.status === 'CLOSED')

    const result = await db.$transaction(async (tx) => {
      const msg = await tx.supportMessage.create({
        data: {
          ticketId: data.ticketId,
          senderUserId: user.id,
          bodyRich: safeRich,
          bodyPlain: data.bodyPlain,
          isInternal: data.isInternal,
          mentionedUserIds: mentionIds,
        },
      })

      if (data.attachments?.length) {
        await tx.supportAttachment.createMany({
          data: data.attachments.map(a => ({
            messageId: msg.id,
            uploadedByUserId: user.id,
            fileName: a.fileName,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
            storageKey: a.storageKey,
            thumbnailKey: a.thumbnailKey,
            width: a.width ?? null,
            height: a.height ?? null,
          })),
        })
      }

      const updates: Record<string, unknown> = { lastActivityAt: new Date() }
      if (!data.isInternal) {
        if (isPlatformReply && !ticket.firstResponseAt) updates.firstResponseAt = new Date()
        if (shouldReopen) {
          updates.status = 'OPEN'
          updates.reopenedCount = { increment: 1 }
          await emitActivity(tx, { ticketId: ticket.id, actorUserId: user.id, type: 'REOPENED' })
        }
      }
      await tx.supportTicket.update({ where: { id: ticket.id }, data: updates })

      // Notification 1: assignee notified on public customer reply
      if (!data.isInternal && isCustomerReply && ticket.assignedToUserId && ticket.assignedToUserId !== user.id) {
        await tx.notification.create({
          data: {
            userId: ticket.assignedToUserId,
            tenantId: ticket.tenantId,
            type: 'TICKET_REPLY',
            title: 'New customer reply',
            message: data.bodyPlain.slice(0, 140),
            link: `/support/${ticket.id}`,
          },
        })
      }

      // Notification 2: @mention inside an internal note fires notifications
      if (data.isInternal && mentionIds.length > 0) {
        await tx.notification.createMany({
          data: mentionIds
            .filter(uid => uid !== user.id)
            .map(uid => ({
              userId: uid,
              tenantId: ticket.tenantId,
              type: 'MENTION',
              title: `${user.name ?? user.email} mentioned you`,
              message: data.bodyPlain.slice(0, 140),
              link: `/support/${ticket.id}`,
            })),
        })
      }

      return msg
    })

    revalidatePath(`/support/${data.ticketId}`)
    return result
  },
)
