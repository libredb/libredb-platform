import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtureUrl } from '../../../../tests/db/connect'

// The runtime DATABASE_URL (pg syntax, schema=platform) with the session's search_path forced to public,
// as after a restore that lost the role settings of the bootstrap.
const DATABASE_URL = `${fixtureUrl('platform')}?schema=platform&options=${encodeURIComponent('-c search_path=public')}`

describe('searchTickets', () => {
  let db: typeof import('@/shared/lib/db').db
  let searchTickets: typeof import('./support-search').searchTickets

  beforeAll(async () => {
    // The Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', DATABASE_URL)
    ;({ db } = await import('@/shared/lib/db'))
    ;({ searchTickets } = await import('./support-search'))
  })

  afterAll(async () => {
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('finds a ticket through a client whose search_path is public', async () => {
    const [session] = await db.$queryRaw<Array<{ search_path: string }>>`SHOW search_path`
    expect(session.search_path).toBe('public')

    const marker = `probe${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const ticket = await db.supportTicket.create({
      data: {
        ticketNumber: `TKT-${marker}`,
        subject: `Nightly export fails ${marker}`,
        descriptionPlain: 'The export job stops after the first batch.',
        createdByUserId: 'search-probe-user',
      },
    })
    try {
      const results = await searchTickets({ mode: 'all' }, marker)
      expect(results.map((result) => result.id)).toEqual([ticket.id])
    } finally {
      await db.supportTicket.delete({ where: { id: ticket.id } })
    }
  })
})
