'use client'

import { format } from 'date-fns'
import {
  ArrowRightIcon, TagIcon, UserIcon, CheckCircleIcon,
  RotateCcwIcon, StarIcon, XCircleIcon,
} from 'lucide-react'

export interface TimelineActivityProps {
  activity: {
    id: string
    type: string
    actorUserId: string | null
    metadata: Record<string, any> | null
    createdAt: Date | string
  }
  actorName: string | null
  userMap: Record<string, string>
  statusMap?: Record<string, string>
  priorityMap?: Record<string, string>
}

export function TimelineActivity({
  activity, actorName, userMap, statusMap = {}, priorityMap = {},
}: TimelineActivityProps) {
  const actor = actorName ?? 'System'
  const meta = activity.metadata ?? {}
  let Icon = ArrowRightIcon
  let text: React.ReactNode

  switch (activity.type) {
    case 'ASSIGNED':
      Icon = UserIcon
      text = <><strong>{actor}</strong> assigned the ticket to <strong>{userMap[meta.toUserId] ?? meta.toUserId}</strong></>
      break
    case 'UNASSIGNED':
      Icon = UserIcon
      text = <><strong>{actor}</strong> removed the assignee</>
      break
    case 'STATUS_CHANGED':
      text = <><strong>{actor}</strong> changed the status <em>{statusMap[meta.from] ?? meta.from}</em> → <em>{statusMap[meta.to] ?? meta.to}</em></>
      break
    case 'PRIORITY_CHANGED':
      text = <><strong>{actor}</strong> changed the priority <em>{priorityMap[meta.from] ?? meta.from}</em> → <em>{priorityMap[meta.to] ?? meta.to}</em></>
      break
    case 'CATEGORY_CHANGED':
      text = <><strong>{actor}</strong> changed the category {meta.from} → {meta.to}</>
      break
    case 'TAG_ADDED':
      Icon = TagIcon
      text = <><strong>{actor}</strong> added the tag <span className="rounded bg-primary/10 px-1 text-primary">{meta.tagName}</span></>
      break
    case 'TAG_REMOVED':
      Icon = TagIcon
      text = <><strong>{actor}</strong> removed the tag <span className="line-through">{meta.tagName}</span></>
      break
    case 'REOPENED':
      Icon = RotateCcwIcon
      text = <><strong>{actor}</strong> reopened the ticket</>
      break
    case 'RESOLVED':
      Icon = CheckCircleIcon
      text = <><strong>{actor}</strong> resolved the ticket</>
      break
    case 'CLOSED':
      Icon = XCircleIcon
      text = <><strong>{actor}</strong> closed the ticket</>
      break
    case 'CSAT_RECEIVED':
      Icon = StarIcon
      text = <><strong>Customer</strong> gave {meta.rating}/5 stars</>
      break
    case 'MERGED':
      text = <><strong>{actor}</strong> merged the ticket</>
      break
    default:
      text = <>{activity.type}</>
  }

  return (
    <div className="relative py-1 pl-8">
      <span aria-hidden className="absolute left-[5px] top-2.5 size-[11px] rounded-full border-2 border-muted-foreground bg-muted" />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3" />
        <span>{text}</span>
        <span>·</span>
        <time>{format(new Date(activity.createdAt), 'HH:mm · d MMM')}</time>
      </div>
    </div>
  )
}
