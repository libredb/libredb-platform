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

// Unit abbreviations (Turkish): "g" = gün, "sa" = saat, "dk" = dakika.
// The previous single-letter "s"/"d" suffixes were ambiguous: "s" reads
// as saniye and "d" as day, so we use unambiguous 2-letter forms.
function fmt(ms: number): string {
  const abs = Math.abs(ms)
  const totalMin = Math.floor(abs / 60_000)
  const d = Math.floor(totalMin / (60 * 24))
  const h = Math.floor((totalMin % (60 * 24)) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}g ${h}sa ${m}dk`
  if (h > 0) return `${h}sa ${m}dk`
  return `${m}dk`
}

export function SlaBadge({ ticket }: SlaBadgeProps) {
  const s = calculateSlaStatus({
    createdAt: new Date(ticket.createdAt),
    priority: ticket.priority,
    firstResponseAt: ticket.firstResponseAt ? new Date(ticket.firstResponseAt) : null,
    resolvedAt: ticket.resolvedAt ? new Date(ticket.resolvedAt) : null,
  })

  if (s.firstResponse && 'overdue' in s.firstResponse && s.firstResponse.overdue) {
    return <span className="text-destructive">🔴 {fmt(-s.firstResponse.remainingMs)} geç · ilk yanıt SLA</span>
  }
  if (s.firstResponse && 'overdue' in s.firstResponse) {
    return <span>⏱ {fmt(s.firstResponse.remainingMs)} · ilk yanıt</span>
  }
  if ('overdue' in s.resolution && s.resolution.overdue) {
    return <span className="text-destructive">🔴 {fmt(-s.resolution.remainingMs)} geç · çözüm SLA</span>
  }
  if ('overdue' in s.resolution) {
    return <span>⏱ {fmt(s.resolution.remainingMs)} · çözüm</span>
  }
  return <span className="text-muted-foreground">✓ SLA karşılandı</span>
}
