'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { CheckCheckIcon, BellIcon } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { Separator } from '@/shared/components/ui/separator'
import { useAction } from '@/shared/hooks/use-action'
import { markNotificationRead } from '../actions/mark-read'

interface Notification {
  id: string
  type: string
  title: string
  message: string
  link: string | null
  read: boolean
  createdAt: string
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000,
  )
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

interface NotificationListProps {
  onClose: () => void
}

export function NotificationList({ onClose }: NotificationListProps) {
  const router = useRouter()
  const queryClient = useQueryClient()

  const { data: notifications, isLoading } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: async () => {
      const res = await fetch('/api/notifications/unread-count?include=list')
      if (!res.ok) return []
      const data = await res.json()
      return (data.notifications ?? []) as Notification[]
    },
  })

  const { execute: markRead } = useAction(markNotificationRead, {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const handleMarkAllRead = () => {
    markRead({ all: true })
  }

  const handleClick = (notification: Notification) => {
    if (!notification.read) {
      markRead({ id: notification.id })
    }
    if (notification.link) {
      onClose()
      router.push(notification.link)
    }
  }

  const items = notifications ?? []
  const hasUnread = items.some((n) => !n.read)

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <h4 className="text-sm font-semibold">Notifications</h4>
        {hasUnread && (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto px-2 py-1 text-xs"
            onClick={handleMarkAllRead}
          >
            <CheckCheckIcon className="mr-1 size-3" />
            Mark all read
          </Button>
        )}
      </div>
      <Separator />
      <ScrollArea className="max-h-80">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8">
            <BellIcon className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No notifications</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {items.map((notification) => (
              <button
                key={notification.id}
                type="button"
                className={`flex flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${
                  !notification.read ? 'bg-muted/30' : ''
                }`}
                onClick={() => handleClick(notification)}
              >
                <div className="flex items-start justify-between gap-2">
                  <p
                    className={`text-sm leading-tight ${
                      !notification.read ? 'font-semibold' : 'font-medium'
                    }`}
                  >
                    {notification.title}
                  </p>
                  {!notification.read && (
                    <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
                  )}
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {notification.message}
                </p>
                <p className="text-[10px] text-muted-foreground/70">
                  {timeAgo(notification.createdAt)}
                </p>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
