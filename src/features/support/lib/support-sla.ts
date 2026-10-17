export const SLA_FIRST_RESPONSE: Record<string, number> = { LOW: 24, MEDIUM: 8, HIGH: 4, URGENT: 1 }
export const SLA_RESOLUTION:     Record<string, number> = { LOW: 168, MEDIUM: 48, HIGH: 24, URGENT: 8 }

interface TicketSlaInput {
  createdAt: Date
  priority: string
  firstResponseAt: Date | null
  resolvedAt: Date | null
}

export interface SlaClock {
  target: Date
  overdue: boolean
  remainingMs: number
}

export interface SlaStatus {
  firstResponse: SlaClock | { met: true } | null
  resolution: SlaClock | { met: true }
  overallBreached: boolean
}

export function calculateSlaStatus(ticket: TicketSlaInput): SlaStatus {
  const now = Date.now()

  const frHours = SLA_FIRST_RESPONSE[ticket.priority] ?? SLA_FIRST_RESPONSE.MEDIUM
  const resHours = SLA_RESOLUTION[ticket.priority] ?? SLA_RESOLUTION.MEDIUM

  const firstResponse =
    ticket.firstResponseAt !== null
      ? ({ met: true } as const)
      : buildClock(ticket.createdAt.getTime() + frHours * 3600_000, now)

  const resolution =
    ticket.resolvedAt !== null
      ? ({ met: true } as const)
      : buildClock(ticket.createdAt.getTime() + resHours * 3600_000, now)

  const frOverdue = firstResponse !== null && 'overdue' in firstResponse && firstResponse.overdue
  const resOverdue = 'overdue' in resolution && resolution.overdue

  return { firstResponse, resolution, overallBreached: frOverdue || resOverdue }
}

function buildClock(target: number, now: number): SlaClock {
  return { target: new Date(target), overdue: now > target, remainingMs: target - now }
}
