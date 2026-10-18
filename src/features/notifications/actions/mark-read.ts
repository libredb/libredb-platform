'use server'

import { z } from 'zod'
import { safeAction } from '@/shared/lib/safe-action'
import { NotificationRepository } from '../lib/notification.repository'
import { revalidatePath } from 'next/cache'

const markReadSchema = z.object({
  id: z.string().optional(),
  all: z.boolean().optional(),
})

export const markNotificationRead = safeAction(
  'markNotificationRead',
  markReadSchema,
  async (data, user) => {
    if (data.all) {
      await NotificationRepository.markAllAsRead(user.id)
    } else if (data.id) {
      await NotificationRepository.markAsRead(data.id, user.id)
    }

    revalidatePath('/')
    return { success: true }
  },
)
