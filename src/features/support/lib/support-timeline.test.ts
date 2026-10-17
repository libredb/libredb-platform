import { describe, it, expect } from 'vitest'
import { buildTimeline } from './support-timeline'

const msg = (id: string, iso: string, isInternal = false) => ({
  id, senderUserId: 'u', bodyRich: null, bodyPlain: 'hello', isInternal,
  mentionedUserIds: [], editedAt: null, attachments: [],
  createdAt: new Date(iso),
})
const act = (id: string, iso: string, type = 'ASSIGNED') => ({
  id, actorUserId: 'u', type, metadata: null, ticketId: 'tk1',
  createdAt: new Date(iso),
})

describe('buildTimeline', () => {
  it('merges and sorts by createdAt ASC', () => {
    const messages = [msg('m1', '2026-04-15T10:00:00Z'), msg('m2', '2026-04-15T12:00:00Z')]
    const activities = [act('a1', '2026-04-15T11:00:00Z')]
    const out = buildTimeline(messages as any, activities as any, { includeInternal: true })
    expect(out.map(i => i.data.id)).toEqual(['m1', 'a1', 'm2'])
    expect(out.map(i => i.kind)).toEqual(['message', 'activity', 'message'])
  })

  it('filters internal notes when includeInternal is false', () => {
    const messages = [msg('m1', '2026-04-15T10:00:00Z', false), msg('m2', '2026-04-15T11:00:00Z', true)]
    const out = buildTimeline(messages as any, [], { includeInternal: false })
    expect(out.map(i => i.data.id)).toEqual(['m1'])
  })

  it('keeps internal notes when includeInternal is true', () => {
    const messages = [msg('m1', '2026-04-15T10:00:00Z', true)]
    const out = buildTimeline(messages as any, [], { includeInternal: true })
    expect(out).toHaveLength(1)
  })

  it('handles empty inputs', () => {
    expect(buildTimeline([], [], { includeInternal: true })).toEqual([])
  })

  it('accepts ISO string createdAt (SSR-serialized input)', () => {
    // After JSON round-trip across the server boundary, createdAt is a string.
    const msgStr = (id: string, iso: string) => ({
      id, senderUserId: 'u', bodyRich: null, bodyPlain: 'hi', isInternal: false,
      mentionedUserIds: [], editedAt: null, attachments: [],
      createdAt: iso,
    })
    const actStr = (id: string, iso: string) => ({
      id, actorUserId: 'u', type: 'ASSIGNED', metadata: null, ticketId: 'tk1',
      createdAt: iso,
    })
    const messages = [msgStr('m1', '2026-04-15T10:00:00Z'), msgStr('m2', '2026-04-15T12:00:00Z')]
    const activities = [actStr('a1', '2026-04-15T11:00:00Z')]
    const out = buildTimeline(messages as any, activities as any, { includeInternal: true })
    expect(out.map(i => i.data.id)).toEqual(['m1', 'a1', 'm2'])
  })
})
