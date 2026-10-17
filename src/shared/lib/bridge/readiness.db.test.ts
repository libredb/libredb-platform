import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { createFreshDatabase } from '../../../../tests/db/fresh-database'

// A database of its own, because one test withdraws contract version 1 and another marks a migration rolled back.
const DATABASE = 'libredb_readiness'

describe('readiness on PostgreSQL', () => {
  let readiness: typeof import('./readiness')
  let db: typeof import('@/shared/lib/db').db

  beforeAll(async () => {
    await createFreshDatabase(DATABASE)
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform', DATABASE)}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    readiness = await import('./readiness')
  })

  afterAll(async () => {
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('a migrated database with contract v1 is ready', async () => {
    // The migration publish_contract_v1 publishes version 1.
    await expect(readiness.checkReadiness(db)).resolves.toEqual({ status: 'ready', contract: 1 })
  })

  it('a migrated database without contract v1 reports contract-missing', async () => {
    // Withdraws version 1 as bridge.contract was before it was published; CREATE OR REPLACE VIEW keeps the grants.
    const superuser = await connectSuperuser(DATABASE)
    try {
      await superuser.query(`
        CREATE OR REPLACE VIEW bridge.contract WITH (security_barrier = true, security_invoker = false) AS
        SELECT c.version, c.status, c.sunset_after, c.notify_channel
        FROM (VALUES (1::smallint, 'current'::text, NULL::timestamptz, 'libredb_bridge'::text))
             AS c(version, status, sunset_after, notify_channel)
        WHERE false`)
    } finally {
      await superuser.end()
    }

    await expect(readiness.checkReadiness(db)).resolves.toEqual({ status: 'not-ready', reason: 'contract-missing' })
  })

  it('a migration rolled back in the history is pending again', async () => {
    const [latest] = readiness.localMigrations().slice(-1)
    const superuser = await connectSuperuser(DATABASE)
    try {
      await superuser.query('UPDATE platform._prisma_migrations SET rolled_back_at = now() WHERE migration_name = $1', [latest])
    } finally {
      await superuser.end()
    }

    await expect(readiness.checkReadiness(db)).resolves.toEqual({
      status: 'not-ready',
      reason: 'pending-migrations',
      pending: [latest],
    })
  })
})
