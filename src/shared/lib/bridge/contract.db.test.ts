import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtureUrl } from '../../../../tests/db/connect'

describe('published bridge contracts on PostgreSQL', () => {
  let contract: typeof import('./contract')
  let db: typeof import('@/shared/lib/db').db

  beforeAll(async () => {
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    contract = await import('./contract')
  })

  afterAll(async () => {
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('readPublishedContracts returns version 1', async () => {
    expect(contract.PLATFORM_BRIDGE_CONTRACT_VERSION).toBe(1)
    expect(contract.BRIDGE_NOTIFY_CHANNEL).toBe('libredb_bridge')
    await expect(contract.readPublishedContracts(db)).resolves.toEqual([
      { version: 1, status: 'current', sunsetAfter: null, notifyChannel: 'libredb_bridge' },
    ])
  })
})
