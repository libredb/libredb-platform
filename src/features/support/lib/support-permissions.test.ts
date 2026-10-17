import { describe, it, expect } from 'vitest'
import {
  canViewTicket,
  canManageTicket,
  canSeeInternalNotes,
  canEditMessage,
  canReopenTicket,
} from './support-permissions'
import { PERMISSIONS } from '@/shared/lib/permissions'
import type { CurrentUser } from '@/shared/types'

function makeUser(opts: Partial<CurrentUser> & { permissions: string[] }): CurrentUser {
  return {
    id: 'u1', email: 'u1@test', name: 'User 1',
    currentTenantId: 't1', membershipId: 'm1',
    roles: [], accessibleTenants: [],
    ...opts,
  } as CurrentUser
}

const ticketOwn  = { id: 'tk1', tenantId: 't1', createdByUserId: 'u1', assignedToUserId: null }
const ticketPeer = { id: 'tk2', tenantId: 't1', createdByUserId: 'u2', assignedToUserId: null }
const ticketOther = { id: 'tk3', tenantId: 't9', createdByUserId: 'u9', assignedToUserId: null }

describe('canViewTicket', () => {
  it('platform staff with TICKET_VIEW_ALL sees everything', () => {
    const u = makeUser({ permissions: [PERMISSIONS.TICKET_VIEW_ALL] })
    expect(canViewTicket(u, ticketOwn)).toBe(true)
    expect(canViewTicket(u, ticketPeer)).toBe(true)
    expect(canViewTicket(u, ticketOther)).toBe(true)
  })

  it('owner sees own', () => {
    const u = makeUser({ permissions: [PERMISSIONS.TICKET_VIEW] })
    expect(canViewTicket(u, ticketOwn)).toBe(true)
  })

  it('assignee sees assigned', () => {
    const u = makeUser({ permissions: [PERMISSIONS.TICKET_VIEW] })
    expect(canViewTicket(u, { ...ticketPeer, assignedToUserId: 'u1' })).toBe(true)
  })

  it('tenant admin with TICKET_VIEW_TENANT sees tenant peers', () => {
    const u = makeUser({ permissions: [PERMISSIONS.TICKET_VIEW, PERMISSIONS.TICKET_VIEW_TENANT] })
    expect(canViewTicket(u, ticketPeer)).toBe(true)
    expect(canViewTicket(u, ticketOther)).toBe(false)
  })

  it('regular user cannot see others', () => {
    const u = makeUser({ permissions: [PERMISSIONS.TICKET_VIEW] })
    expect(canViewTicket(u, ticketPeer)).toBe(false)
  })
})

describe('canManageTicket', () => {
  it('requires both TICKET_MANAGE and view access', () => {
    const platform = makeUser({ permissions: [PERMISSIONS.TICKET_MANAGE, PERMISSIONS.TICKET_VIEW_ALL] })
    expect(canManageTicket(platform, ticketOther)).toBe(true)

    const onlyManage = makeUser({ permissions: [PERMISSIONS.TICKET_MANAGE] })
    expect(canManageTicket(onlyManage, ticketOther)).toBe(false)
  })
})

describe('canSeeInternalNotes', () => {
  it('platform-only', () => {
    expect(canSeeInternalNotes(makeUser({ permissions: [PERMISSIONS.TICKET_VIEW_ALL] }))).toBe(true)
    expect(canSeeInternalNotes(makeUser({ permissions: [PERMISSIONS.TICKET_VIEW_TENANT] }))).toBe(false)
    expect(canSeeInternalNotes(makeUser({ permissions: [PERMISSIONS.TICKET_VIEW] }))).toBe(false)
  })
})

describe('canEditMessage', () => {
  const now = new Date()
  const fresh = { senderUserId: 'u1', createdAt: new Date(now.getTime() - 5 * 60 * 1000), editedAt: null }
  const stale = { senderUserId: 'u1', createdAt: new Date(now.getTime() - 20 * 60 * 1000), editedAt: null }
  const other = { senderUserId: 'u2', createdAt: new Date(now.getTime() - 1 * 60 * 1000), editedAt: null }

  it('own + within 15min', () => {
    const u = makeUser({ permissions: [] })
    expect(canEditMessage(u, fresh as any)).toBe(true)
  })
  it('own + stale → no', () => {
    const u = makeUser({ permissions: [] })
    expect(canEditMessage(u, stale as any)).toBe(false)
  })
  it('not own → no', () => {
    const u = makeUser({ permissions: [] })
    expect(canEditMessage(u, other as any)).toBe(false)
  })
})

describe('canReopenTicket', () => {
  it('creator or manager can reopen', () => {
    const creator = makeUser({ permissions: [PERMISSIONS.TICKET_VIEW] })
    expect(canReopenTicket(creator, ticketOwn)).toBe(true)

    const manager = makeUser({ permissions: [PERMISSIONS.TICKET_MANAGE, PERMISSIONS.TICKET_VIEW_ALL] })
    expect(canReopenTicket(manager, ticketOther)).toBe(true)

    const stranger = makeUser({ permissions: [PERMISSIONS.TICKET_VIEW] })
    expect(canReopenTicket(stranger, ticketOther)).toBe(false)
  })
})
