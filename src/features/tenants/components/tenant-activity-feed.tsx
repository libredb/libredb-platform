import {
  DatabaseIcon,
  LifeBuoyIcon,
  MailOpenIcon,
  type LucideIcon,
  CircleIcon,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Badge } from '@/shared/components/ui/badge'

/** Discriminated activity union: matches TenantRepository.findRecentActivity */
export type ActivityItem =
  | {
      kind: 'query'
      id: string
      at: string
      username: string | null
      subject: string
      statementType: string
      status: string
      connectionName: string
      durationMs: number
    }
  | {
      kind: 'ticket'
      id: string
      at: string
      ticketNumber: string
      subject: string
      status: string
      priority: string
    }
  | {
      kind: 'invitation'
      id: string
      at: string
      email: string
      accepted: boolean
    }

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No activity in this tenant yet.
      </p>
    )
  }

  return (
    <ol className="space-y-0">
      {items.map((item, i) => (
        <li
          key={`${item.kind}-${item.id}`}
          className="relative flex gap-3 py-3 first:pt-0 last:pb-0"
        >
          {/* Connector line */}
          {i < items.length - 1 && (
            <span
              aria-hidden
              className="absolute left-[11px] top-9 h-[calc(100%-0.5rem)] w-px bg-border"
            />
          )}
          <ActivityIcon kind={item.kind} />
          <div className="flex-1 space-y-0.5">
            <ActivityContent item={item} />
            <p className="text-xs text-muted-foreground">
              {formatDistanceToNow(new Date(item.at), { addSuffix: true })}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function ActivityIcon({ kind }: { kind: ActivityItem['kind'] }) {
  const map: Record<
    ActivityItem['kind'],
    { Icon: LucideIcon; className: string }
  > = {
    query: {
      Icon: DatabaseIcon,
      className: 'bg-primary/10 text-primary',
    },
    ticket: {
      Icon: LifeBuoyIcon,
      className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
    invitation: {
      Icon: MailOpenIcon,
      className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    },
  }
  const { Icon, className } = map[kind]
  return (
    <div className={`flex size-6 shrink-0 items-center justify-center rounded-full ${className}`}>
      <Icon className="size-3.5" />
    </div>
  )
}

function ActivityContent({ item }: { item: ActivityItem }) {
  switch (item.kind) {
    case 'query':
      return (
        <p className="text-sm">
          <span className="font-medium text-foreground" title={item.subject}>
            {item.username ?? item.subject}
          </span>{' '}
          ran a{' '}
          <Badge variant="outline" className="mx-0.5">
            {item.statementType}
          </Badge>{' '}
          query on{' '}
          <span className="font-mono text-xs text-muted-foreground">
            {item.connectionName}
          </span>
          {item.status !== 'success' && (
            <Badge variant="destructive" className="ml-1.5">
              {item.status}
            </Badge>
          )}
          <span className="ml-1.5 text-xs text-muted-foreground">
            · {item.durationMs}ms
          </span>
        </p>
      )
    case 'ticket':
      return (
        <p className="text-sm">
          Ticket{' '}
          <span className="font-mono text-xs">{item.ticketNumber}</span>
          {' · '}
          <span className="text-foreground">{item.subject}</span>
          <Badge
            variant={
              item.status === 'OPEN'
                ? 'warning'
                : item.status === 'RESOLVED' || item.status === 'CLOSED'
                  ? 'success'
                  : 'secondary'
            }
            className="ml-1.5"
          >
            {item.status}
          </Badge>
        </p>
      )
    case 'invitation':
      return (
        <p className="text-sm">
          {item.accepted ? (
            <>
              <span className="font-medium text-foreground">{item.email}</span>{' '}
              accepted their invitation
            </>
          ) : (
            <>
              Invitation sent to{' '}
              <span className="font-medium text-foreground">{item.email}</span>
            </>
          )}
        </p>
      )
    default: {
      // Exhaustiveness check
      const _exhaustive: never = item
      void _exhaustive
      return <CircleIcon className="size-3" />
    }
  }
}
