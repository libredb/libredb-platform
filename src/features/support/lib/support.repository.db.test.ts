import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'

// Every row of this file carries this marker in its ids, so the cleanup removes exactly them.
const MARKER = `support-repository-${randomUUID().slice(0, 8)}`
const PLAN_ID = `${MARKER}-plan`
const TENANT_ID = `${MARKER}-tenant`

describe('SupportRepository on PostgreSQL', () => {
  let SupportRepository: typeof import('./support.repository').SupportRepository
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client

  beforeAll(async () => {
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    ;({ SupportRepository } = await import('./support.repository'))
    superuser = await connectSuperuser()

    await superuser.query(`INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, $1, 'Probe', now())`, [
      PLAN_ID,
    ])
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'Probe', $1, $2, now())`,
      [TENANT_ID, PLAN_ID],
    )
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.support_tickets WHERE "tenantId" = $1', [TENANT_ID])
    await superuser.query('DELETE FROM platform.tenants WHERE id = $1', [TENANT_ID])
    await superuser.query('DELETE FROM platform.plan_configs WHERE id = $1', [PLAN_ID])
    await superuser.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('createWithAutoNumber retries with the next number when a concurrent create took the counted one', async () => {
    // The tenant's one ticket holds TKT-0002, the number its count gives the next create, as when a concurrent create
    // inserted that number between this create's count and its insert.
    await superuser.query(
      `INSERT INTO platform.support_tickets (id, "tenantId", "ticketNumber", subject, "createdByUserId", "updatedAt")
       VALUES ($1, $2, 'TKT-0002', 'Taken', 'probe', now())`,
      [`${MARKER}-taken`, TENANT_ID],
    )

    const created = await SupportRepository.createWithAutoNumber(TENANT_ID, (ticketNumber, tx) =>
      tx.supportTicket.create({ data: { tenantId: TENANT_ID, ticketNumber, subject: 'Probe', createdByUserId: 'probe' } }),
    )

    expect(created.ticketNumber).toBe('TKT-0003')
  })
})
