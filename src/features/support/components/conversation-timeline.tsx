'use client'

import { useEffect, useRef } from 'react'
import { buildTimeline } from '@/features/support/lib/support-timeline'
import { TimelineMessage } from './timeline-message'
import { TimelineActivity } from './timeline-activity'

interface ConversationTimelineProps {
  messages: any[]
  activities: any[]
  includeInternal: boolean
  currentUserId: string
  userMap: Record<string, string>
  statusMap?: Record<string, string>
  priorityMap?: Record<string, string>
  platformStaffIds: Set<string>
}

export function ConversationTimeline({
  messages, activities, includeInternal, currentUserId, userMap,
  statusMap, priorityMap, platformStaffIds,
}: ConversationTimelineProps) {
  const items = buildTimeline(messages, activities, { includeInternal })
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [items.length])

  if (items.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Henüz mesaj yok.</div>
  }

  return (
    <div className="relative">
      <span aria-hidden className="absolute bottom-2 left-[10px] top-2 w-px bg-border" />
      <div className="flex flex-col gap-3">
        {items.map(item => {
          if (item.kind === 'message') {
            const m = item.data
            const senderName = userMap[m.senderUserId] ?? 'Bilinmeyen'
            const senderRole = platformStaffIds.has(m.senderUserId) ? 'agent' : 'customer'
            return (
              <TimelineMessage
                key={`m-${m.id}`}
                message={m as any}
                senderName={senderName}
                senderRole={senderRole as any}
                isOwn={m.senderUserId === currentUserId}
                canEdit={false}
              />
            )
          }
          return (
            <TimelineActivity
              key={`a-${item.data.id}`}
              activity={item.data as any}
              actorName={item.data.actorUserId ? (userMap[item.data.actorUserId] ?? null) : null}
              userMap={userMap}
              statusMap={statusMap}
              priorityMap={priorityMap}
            />
          )
        })}
        <div ref={endRef} />
      </div>
    </div>
  )
}
