'use client'

import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { Badge } from '@/shared/components/ui/badge'
import { calculateSlaStatus } from '@/features/support/lib/support-sla'

export function InboxListRow({
  ticket, active, href,
}: { ticket: any; active: boolean; href: string }) {
  const sla = calculateSlaStatus({
    createdAt: new Date(ticket.createdAt),
    priority: ticket.priority,
    firstResponseAt: ticket.firstResponseAt ? new Date(ticket.firstResponseAt) : null,
    resolvedAt: ticket.resolvedAt ? new Date(ticket.resolvedAt) : null,
  })
  return (
    <Link href={href} className={`block border-b px-3 py-2.5 transition-colors ${active ? 'bg-accent' : 'hover:bg-accent/40'}`}>
      <div className="flex items-baseline justify-between text-[10px] text-muted-foreground">
        <span className="font-mono">{ticket.ticketNumber}</span>
        <span className="flex items-center gap-1">
          {sla.overallBreached && <span className="text-destructive">SLA</span>}
          <time>{formatDistanceToNow(new Date(ticket.lastActivityAt), { addSuffix: false })}</time>
        </span>
      </div>
      <div className="mt-1 truncate text-sm font-medium">{ticket.subject}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Badge variant={ticket.priority === 'URGENT' || ticket.priority === 'HIGH' ? 'destructive' : 'secondary'} className="h-4 text-[9px]">
          {ticket.priority}
        </Badge>
        {ticket.tags?.slice(0, 2).map((t: any) => (
          <span key={t.tag.id} className="rounded px-1.5 text-[9px]"
            style={{ backgroundColor: (t.tag.colorCode ?? '#6366f1') + '22', color: t.tag.colorCode ?? '#6366f1' }}>
            {t.tag.name}
          </span>
        ))}
      </div>
    </Link>
  )
}
