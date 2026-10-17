import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { calculateSlaStatus, SLA_FIRST_RESPONSE, SLA_RESOLUTION } from './support-sla'

const NOW = new Date('2026-04-15T12:00:00Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

function ticket(overrides: any = {}) {
  return {
    createdAt: new Date('2026-04-15T10:00:00Z'),
    priority: 'MEDIUM',
    firstResponseAt: null,
    resolvedAt: null,
    ...overrides,
  }
}

describe('calculateSlaStatus', () => {
  it('MEDIUM first-response is 8h; 2h elapsed -> 6h remaining', () => {
    const s = calculateSlaStatus(ticket() as any)
    expect(s.firstResponse).not.toBeNull()
    // firstResponse has 'overdue' field when not met
    expect((s.firstResponse as any).overdue).toBe(false)
    expect((s.firstResponse as any).remainingMs).toBe(6 * 3600_000)
  })

  it('URGENT first-response is 1h; 2h elapsed -> overdue', () => {
    const s = calculateSlaStatus(ticket({ priority: 'URGENT' }) as any)
    expect((s.firstResponse as any).overdue).toBe(true)
  })

  it('firstResponseAt set -> firstResponse.met', () => {
    const s = calculateSlaStatus(ticket({ firstResponseAt: new Date('2026-04-15T10:30:00Z') }) as any)
    expect(s.firstResponse).toEqual({ met: true })
  })

  it('resolvedAt set -> resolution.met', () => {
    const s = calculateSlaStatus(ticket({ resolvedAt: new Date('2026-04-15T11:00:00Z') }) as any)
    expect(s.resolution).toEqual({ met: true })
  })

  it('hours tables are correct', () => {
    expect(SLA_FIRST_RESPONSE.URGENT).toBe(1)
    expect(SLA_FIRST_RESPONSE.LOW).toBe(24)
    expect(SLA_RESOLUTION.MEDIUM).toBe(48)
  })
})
