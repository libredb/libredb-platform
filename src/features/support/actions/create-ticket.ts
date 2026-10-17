'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { revalidatePath } from 'next/cache'
import { createTicketSchema } from '../lib/support.schema'
import { SupportRepository } from '../lib/support.repository'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { LimitExceededError } from '@/shared/lib/errors'
import { sanitizeTicketHtml } from '../lib/support-sanitize'
import {
  MAX_FILES_PER_MESSAGE,
  MAX_TICKET_BYTES,
} from '../lib/attachment-allowlist'

export const createTicket = safeAction(
  'createTicket',
  createTicketSchema,
  async (data, user) => {
    await requirePermission(user, PERMISSIONS.TICKET_CREATE)

    // Attachment limits: server-side backstop (client-side enforcement can
    // be bypassed). A brand-new ticket has no pre-existing attachments so
    // the per-ticket byte cap reduces to the incoming batch.
    const attachments = data.attachments ?? []
    if (attachments.length > MAX_FILES_PER_MESSAGE) {
      throw new LimitExceededError('attachments-per-message', MAX_FILES_PER_MESSAGE)
    }
    const incomingBytes = attachments.reduce((sum, a) => sum + a.fileSize, 0)
    if (incomingBytes > MAX_TICKET_BYTES) {
      throw new LimitExceededError('ticket-total-bytes', MAX_TICKET_BYTES)
    }

    const tenantId = user.currentTenantId ?? null
    const safeRich = sanitizeTicketHtml(data.descriptionRich)

    // createWithAutoNumber allocates a per-tenant ticket number inside a
    // transaction and retries on unique-constraint collisions, so concurrent
    // creates in the same tenant serialize safely.
    const ticket = await SupportRepository.createWithAutoNumber(tenantId, async (ticketNumber, tx) => {
      const t = await tx.supportTicket.create({
        data: {
          tenantId,
          ticketNumber,
          subject: data.subject,
          descriptionRich: safeRich,
          descriptionPlain: data.descriptionPlain,
          priority: data.priority,
          category: data.category,
          status: 'OPEN',
          createdByUserId: user.id,
          lastActivityAt: new Date(),
        },
      })

      // Mirror description into first SupportMessage so attachments hang off a message.
      const firstMsg = await tx.supportMessage.create({
        data: {
          ticketId: t.id,
          senderUserId: user.id,
          bodyRich: safeRich,
          bodyPlain: data.descriptionPlain,
          isInternal: false,
        },
      })

      if (data.attachments?.length) {
        await tx.supportAttachment.createMany({
          data: data.attachments.map(a => ({
            messageId: firstMsg.id,
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

      return t
    })

    revalidatePath('/support')
    return ticket
  },
)
