'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BellIcon } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { NotificationList } from './notification-list'

export function NotificationBell() {
  const [open, setOpen] = useState(false)

  const { data } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: async () => {
      const res = await fetch('/api/notifications/unread-count')
      if (!res.ok) return { count: 0 }
      return res.json() as Promise<{ count: number }>
    },
    refetchInterval: 60_000,
  })

  const count = data?.count ?? 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon" className="relative">
            <BellIcon className="size-5" />
            {count > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground">
                {count > 9 ? '9+' : count}
              </span>
            )}
            <span className="sr-only">Notifications</span>
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-0">
        <NotificationList onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
