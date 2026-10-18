import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { sealSecret } from '@/shared/lib/sealing/lsb1'

// Every row of this file carries this marker in its ids, so the cleanup removes exactly them.
const MARKER = `tenant-repository-${randomUUID().slice(0, 8)}`
const PLAN_ID = `${MARKER}-plan`
const TENANT_ID = `${MARKER}-tenant`
const OTHER_TENANT_ID = `${MARKER}-other`
const USER_ID = `${MARKER}-user`

// A published test key of Studio's lsb1 vectors, which protects nothing.
const VECTORS_FILE = path.resolve(__dirname, '../../../../tests/fixtures/governance/lsb1-vectors.json')
const CANARY = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors.find(
  (vector: { id: string }) => vector.id === 'canary',
) as { recipientPublicKey: string }
const PUBLIC_KEY = Buffer.from(CANARY.recipientPublicKey, 'base64url')

const DEFINITION = { host: 'db.internal', port: 5432, database: 'orders' }

describe('TenantRepository on PostgreSQL', () => {
  let TenantRepository: typeof import('./tenant.repository').TenantRepository
  let AdminStatsRepository: typeof import('./admin-stats.repository').AdminStatsRepository
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client

  async function insertConnection(tenantId: string, name: string, deleted: boolean): Promise<string> {
    const id = randomUUID()
    const readSecret = sealSecret(
      { connectionId: id, level: 'read', engine: 'postgres', definition: DEFINITION, plaintext: { user: 'reader', password: 'read-pass' } },
      PUBLIC_KEY,
    )
    await superuser.query(
      `INSERT INTO platform.database_connections
         (id, "tenantId", name, engine, definition, "readSecret", active, "deletedAt", "createdById")
       VALUES ($1, $2, $3, 'postgres', $4, $5, $6, $7, $8)`,
      [id, tenantId, name, DEFINITION, readSecret, !deleted, deleted ? new Date() : null, USER_ID],
    )
    return id
  }

  beforeAll(async () => {
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    // Tenant administration exists only in cloud mode.
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    ;({ db } = await import('@/shared/lib/db'))
    ;({ TenantRepository } = await import('./tenant.repository'))
    ;({ AdminStatsRepository } = await import('./admin-stats.repository'))
    superuser = await connectSuperuser()

    await superuser.query(
      `INSERT INTO platform.plan_configs (id, code, name, "maxConnections", "updatedAt") VALUES ($1, $1, 'Probe', 5, now())`,
      [PLAN_ID],
    )
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "createdAt", "updatedAt")
       VALUES ($1, 'Probe', $1, $3, now() + interval '1 day', now()), ($2, 'Other', $2, $3, now(), now())`,
      [TENANT_ID, OTHER_TENANT_ID, PLAN_ID],
    )
    await superuser.query(`INSERT INTO platform.users (id, email, "updatedAt") VALUES ($1, 'probe@libredb.test', now())`, [USER_ID])
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.database_connections WHERE "createdById" = $1', [USER_ID])
    await superuser.query('DELETE FROM platform.users WHERE id LIKE $1', [`${MARKER}-%`])
    await superuser.query('DELETE FROM platform.tenants WHERE id IN ($1, $2)', [TENANT_ID, OTHER_TENANT_ID])
    await superuser.query('DELETE FROM platform.plan_configs WHERE id = $1', [PLAN_ID])
    await superuser.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('tenant usage counts only connections that are not deleted', async () => {
    const orders = await insertConnection(TENANT_ID, 'Orders', false)
    await insertConnection(TENANT_ID, 'Billing', false)
    await insertConnection(TENANT_ID, 'Retired', true)
    await insertConnection(OTHER_TENANT_ID, 'Elsewhere', false)

    expect((await TenantRepository.findById(TENANT_ID))._count).toEqual({ members: 0, connections: 2 })

    const listed = (await TenantRepository.findAll({ search: MARKER })).find((tenant) => tenant.id === TENANT_ID)
    expect(listed?._count).toEqual({ members: 0, connections: 2 })

    const details = await TenantRepository.findByIdWithDetails(TENANT_ID)
    expect(details._count).toMatchObject({ members: 0, connections: 2 })
    expect(details.connections.map((connection) => connection.name).sort()).toEqual(['Billing', 'Orders'])
    expect(details.connections.find((connection) => connection.id === orders)).toEqual({
      id: orders,
      name: 'Orders',
      engine: 'postgres',
      hostSummary: 'db.internal:5432/orders',
      active: true,
      createdAt: expect.any(Date),
    })
    expect(JSON.stringify(details)).not.toContain('lsb1.')

    const recent = await AdminStatsRepository.getRecentTenants(1)
    expect(recent.map((tenant) => [tenant.id, tenant._count])).toEqual([[TENANT_ID, { members: 0, connections: 2 }]])
  })

  it('the Active Users count of the admin dashboard leaves out inactive users', async () => {
    const before = (await AdminStatsRepository.getStats()).users

    await superuser.query(
      `INSERT INTO platform.users (id, email, active, "updatedAt")
       VALUES ($1, 'active@libredb.test', true, now()), ($2, 'inactive@libredb.test', false, now())`,
      [`${MARKER}-active`, `${MARKER}-inactive`],
    )

    expect((await AdminStatsRepository.getStats()).users).toBe(before + 1)
  })
})
