'use client'

import { calculateSlaStatus } from '@/features/support/lib/support-sla'

interface SlaBadgeProps {
  ticket: {
    createdAt: Date | string
    priority: string
    firstResponseAt: Date | string | null
    resolvedAt: Date | string | null
  }
}

// Unit abbreviations: "d" = days, "h" = hours, "m" = minutes.
// The badge never shows seconds or months, so "m" always reads as minutes.
function fmt(ms: number): string {
  const abs = Math.abs(ms)
  const totalMin = Math.floor(abs / 60_000)
  const d = Math.floor(totalMin / (60 * 24))
  const h = Math.floor((totalMin % (60 * 24)) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function SlaBadge({ ticket }: SlaBadgeProps) {
  const s = calculateSlaStatus({
    createdAt: new Date(ticket.createdAt),
    priority: ticket.priority,
    firstResponseAt: ticket.firstResponseAt ? new Date(ticket.firstResponseAt) : null,
    resolvedAt: ticket.resolvedAt ? new Date(ticket.resolvedAt) : null,
  })

  if (s.firstResponse && 'overdue' in s.firstResponse && s.firstResponse.overdue) {
    return <span className="text-destructive">🔴 {fmt(-s.firstResponse.remainingMs)} overdue · first response SLA</span>
  }
  if (s.firstResponse && 'overdue' in s.firstResponse) {
    return <span>⏱ {fmt(s.firstResponse.remainingMs)} · first response</span>
  }
  if ('overdue' in s.resolution && s.resolution.overdue) {
    return <span className="text-destructive">🔴 {fmt(-s.resolution.remainingMs)} overdue · resolution SLA</span>
  }
  if ('overdue' in s.resolution) {
    return <span>⏱ {fmt(s.resolution.remainingMs)} · resolution</span>
  }
  return <span className="text-muted-foreground">✓ SLA met</span>
}
