import { describe, it, expect, vi } from 'vitest'
import { emitActivity, ACTIVITY_TYPES } from './support-activity'

describe('emitActivity', () => {
  it('creates an activity row for STATUS_CHANGED', async () => {
    const tx = { supportActivity: { create: vi.fn().mockResolvedValue({ id: 'a1' }) } } as any
    await emitActivity(tx, {
      ticketId: 'tk1',
      actorUserId: 'u1',
      type: 'STATUS_CHANGED',
      metadata: { from: 'OPEN', to: 'RESOLVED' },
    })
    expect(tx.supportActivity.create).toHaveBeenCalledWith({
      data: {
        ticketId: 'tk1',
        actorUserId: 'u1',
        type: 'STATUS_CHANGED',
        metadata: { from: 'OPEN', to: 'RESOLVED' },
      },
    })
  })

  it('exposes all activity types', () => {
    expect(ACTIVITY_TYPES).toContain('ASSIGNED')
    expect(ACTIVITY_TYPES).toContain('TAG_ADDED')
    expect(ACTIVITY_TYPES).toContain('CSAT_RECEIVED')
    expect(ACTIVITY_TYPES.length).toBeGreaterThanOrEqual(12)
  })

  it('allows null actorUserId for system events', async () => {
    const tx = { supportActivity: { create: vi.fn().mockResolvedValue({}) } } as any
    await emitActivity(tx, { ticketId: 'tk1', actorUserId: null, type: 'REOPENED' })
    expect(tx.supportActivity.create).toHaveBeenCalledWith({
      data: { ticketId: 'tk1', actorUserId: null, type: 'REOPENED', metadata: undefined },
    })
  })
})
