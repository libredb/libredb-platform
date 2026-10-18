import { db } from '@/shared/lib/db'
import { NotFoundError } from '@/shared/lib/errors'

export class NotificationRepository {
  static async findByUser(userId: string, limit = 10) {
    return db.notification.findMany({
      where: { userId },
      orderBy: [{ read: 'asc' }, { createdAt: 'desc' }],
      take: limit,
    })
  }

  static async countUnread(userId: string) {
    return db.notification.count({ where: { userId, read: false } })
  }

  /** Marks a notification of the user as read; a notification of another user is not found and stays as it is. */
  static async markAsRead(id: string, userId: string) {
    const { count } = await db.notification.updateMany({ where: { id, userId }, data: { read: true } })
    if (count === 0) throw new NotFoundError('Notification')
  }

  static async markAllAsRead(userId: string) {
    return db.notification.updateMany({ where: { userId, read: false }, data: { read: true } })
  }

  static async create(data: {
    userId: string
    tenantId?: string
    type: string
    title: string
    message: string
    link?: string
  }) {
    return db.notification.create({ data })
  }
}
