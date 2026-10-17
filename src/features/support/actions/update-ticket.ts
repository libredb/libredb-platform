'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { revalidatePath } from 'next/cache'
import { updateTicketSchema } from '../lib/support.schema'
import { db } from '@/shared/lib/db'
import { canManageTicket } from '../lib/support-permissions'
import { emitActivity } from '../lib/support-activity'
import { ForbiddenError } from '@/shared/lib/errors'

export const updateTicket = safeAction(
  'updateTicket',
  updateTicketSchema,
  async (data, user) => {
    const ticket = await db.supportTicket.findUnique({
      where: { id: data.id },
      select: {
        id: true, tenantId: true, createdByUserId: true, assignedToUserId: true,
        status: true, priority: true, category: true, subject: true,
      },
    })
    if (!ticket) throw new ForbiddenError()
    if (!canManageTicket(user, ticket)) throw new ForbiddenError()

    const updates: any = { lastActivityAt: new Date() }
    const activities: Array<(tx: any) => Promise<void>> = []

    if (data.status !== undefined && data.status !== ticket.status) {
      updates.status = data.status
      if (data.status === 'RESOLVED') updates.resolvedAt = new Date()
      if (data.status === 'CLOSED') updates.closedAt = new Date()
      const newStatus = data.status as string
      activities.push(tx => emitActivity(tx, {
        ticketId: ticket.id,
        actorUserId: user.id,
        type: newStatus === 'RESOLVED' ? 'RESOLVED' : newStatus === 'CLOSED' ? 'CLOSED' : 'STATUS_CHANGED',
        metadata: { from: ticket.status, to: newStatus },
      }))
    }
    if (data.priority !== undefined && data.priority !== ticket.priority) {
      updates.priority = data.priority
      const newPriority = data.priority as string
      activities.push(tx => emitActivity(tx, {
        ticketId: ticket.id,
        actorUserId: user.id,
        type: 'PRIORITY_CHANGED',
        metadata: { from: ticket.priority, to: newPriority },
      }))
    }
    if (data.category !== undefined && data.category !== ticket.category) {
      updates.category = data.category
      const newCategory = data.category as string
      activities.push(tx => emitActivity(tx, {
        ticketId: ticket.id,
        actorUserId: user.id,
        type: 'CATEGORY_CHANGED',
        metadata: { from: ticket.category, to: newCategory },
      }))
    }
    if (data.assignedToUserId !== undefined && data.assignedToUserId !== ticket.assignedToUserId) {
      updates.assignedToUserId = data.assignedToUserId
      const newAssignee = data.assignedToUserId
      if (newAssignee === null) {
        // UNASSIGNED: the prior assignee is always present here because
        // this branch runs only when the assignee actually changed.
        activities.push(tx => emitActivity(tx, {
          ticketId: ticket.id,
          actorUserId: user.id,
          type: 'UNASSIGNED',
          metadata: { fromUserId: ticket.assignedToUserId! },
        }))
      } else {
        activities.push(tx => emitActivity(tx, {
          ticketId: ticket.id,
          actorUserId: user.id,
          type: 'ASSIGNED',
          metadata: { fromUserId: ticket.assignedToUserId, toUserId: newAssignee },
        }))
      }
    }
    if (data.subject !== undefined && data.subject !== ticket.subject) {
      updates.subject = data.subject
    }

    const result = await db.$transaction(async (tx) => {
      const updated = await tx.supportTicket.update({ where: { id: ticket.id }, data: updates })
      for (const fn of activities) await fn(tx)

      // Notify new assignee
      if (data.assignedToUserId && data.assignedToUserId !== ticket.assignedToUserId && data.assignedToUserId !== user.id) {
        await tx.notification.create({
          data: {
            userId: data.assignedToUserId,
            tenantId: ticket.tenantId,
            type: 'TICKET_ASSIGNED',
            title: 'New ticket assigned to you',
            message: ticket.subject.slice(0, 140),
            link: `/support/${ticket.id}`,
          },
        })
      }

      // Notify creator on resolved
      if (data.status === 'RESOLVED' && ticket.createdByUserId !== user.id) {
        await tx.notification.create({
          data: {
            userId: ticket.createdByUserId,
            tenantId: ticket.tenantId,
            type: 'TICKET_RESOLVED',
            title: 'Ticket resolved',
            message: `${ticket.subject.slice(0, 100)} · You can rate it from 1 to 5 stars.`,
            link: `/support/${ticket.id}`,
          },
        })
      }

      return updated
    })

    revalidatePath('/support')
    revalidatePath(`/support/${ticket.id}`)
    return result
  },
)
