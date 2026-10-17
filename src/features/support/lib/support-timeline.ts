import type { SupportActivity, SupportAttachment, SupportMessage } from '@prisma/client'

// Timeline inputs may arrive either hydrated (Prisma Date) or serialized
// (string, e.g., after SSR JSON round-trip or polling fetch). We accept both.
type DateLike = Date | string

type MessageLike = Omit<SupportMessage, 'createdAt' | 'editedAt'> & {
  createdAt: DateLike
  editedAt: DateLike | null
  attachments: SupportAttachment[]
}

type ActivityLike = Omit<SupportActivity, 'createdAt'> & {
  createdAt: DateLike
}

export type MessageWithAttachments = MessageLike

export type TimelineItem =
  | { kind: 'message'; data: MessageLike }
  | { kind: 'activity'; data: ActivityLike }

export interface BuildTimelineOptions {
  includeInternal: boolean
}

function ts(value: DateLike): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

export function buildTimeline(
  messages: MessageLike[],
  activities: ActivityLike[],
  opts: BuildTimelineOptions,
): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const m of messages) {
    if (!opts.includeInternal && m.isInternal) continue
    items.push({ kind: 'message', data: m })
  }
  for (const a of activities) {
    items.push({ kind: 'activity', data: a })
  }
  items.sort((x, y) => ts(x.data.createdAt) - ts(y.data.createdAt))
  return items
}
