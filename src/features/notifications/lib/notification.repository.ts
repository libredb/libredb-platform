import { db } from '@/shared/lib/db'

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

  static async markAsRead(id: string) {
    return db.notification.update({ where: { id }, data: { read: true } })
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
