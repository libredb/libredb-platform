import { describe, it, expect, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { recordAdminAction, type AdminActionClient } from './admin-actions'

function fakeTx() {
  const create = vi.fn().mockResolvedValue({ id: 'action-1' })
  return { tx: { adminAction: { create } } as unknown as AdminActionClient, create }
}

describe('recordAdminAction', () => {
  it('removes secret-bearing keys from before and after at any depth', async () => {
    const { tx, create } = fakeTx()

    await recordAdminAction(tx, {
      actorId: 'user-1',
      channel: 'web',
      action: 'connection.update',
      targetType: 'connection',
      targetId: 'conn-1',
      before: {
        name: 'orders',
        readSecret: 'lsb1.read',
        writeSecret: 'lsb1.write',
        definition: { host: 'db', password: 'p', ssh: { privateKey: 'k', user: 'u' } },
      },
      after: {
        name: 'orders-eu',
        DB_PASSWORD: 'p',
        apiToken: 't',
        items: [{ clientSecret: 's', label: 'a' }, { credentials: { user: 'u' }, label: 'b' }],
      },
    })

    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: 'user-1',
        channel: 'web',
        action: 'connection.update',
        targetType: 'connection',
        targetId: 'conn-1',
        before: { name: 'orders', definition: { host: 'db', ssh: { user: 'u' } } },
        after: { name: 'orders-eu', items: [{ label: 'a' }, { label: 'b' }] },
      },
    })
  })

  it('writes through the transaction client it is given', async () => {
    const { tx, create } = fakeTx()

    const result = await recordAdminAction(tx, {
      actorId: 'user-1',
      channel: 'api',
      action: 'grant.revoke',
      targetType: 'grant',
      targetId: 'grant-1',
      before: { level: 'read' },
      after: null,
    })

    expect(result).toEqual({ id: 'action-1' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: 'user-1',
        channel: 'api',
        action: 'grant.revoke',
        targetType: 'grant',
        targetId: 'grant-1',
        before: { level: 'read' },
        after: Prisma.DbNull,
      },
    })
  })
})
