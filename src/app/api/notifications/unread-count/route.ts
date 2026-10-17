import { apiError, apiSuccess, getApiUser } from '@/shared/lib/api-utils'
import { NotificationRepository } from '@/features/notifications/lib/notification.repository'

export async function GET(request: Request) {
  const user = await getApiUser()
  if (!user) return apiError('Unauthorized', 401)

  const url = new URL(request.url)
  const includeList = url.searchParams.get('include') === 'list'

  const count = await NotificationRepository.countUnread(user.id)

  if (includeList) {
    const notifications = await NotificationRepository.findByUser(user.id, 20)
    const serialized = notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      link: n.link,
      read: n.read,
      createdAt: n.createdAt.toISOString(),
    }))
    return apiSuccess({ count, notifications: serialized })
  }

  return apiSuccess({ count })
}
