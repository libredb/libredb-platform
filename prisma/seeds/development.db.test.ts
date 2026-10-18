import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectStudio, connectSuperuser, fixtureUrl } from '../../tests/db/connect'
import { createFreshDatabase } from '../../tests/db/fresh-database'
import { developmentSealKeyPair } from '../../scripts/dev/gen-seal-keypair.mjs'
import { CONNECTIONS } from './data/connections'
import { QUERY_EVENTS } from './data/query-events'

// The development seed fills a database of its own, so the counts below see only its rows.
const DATABASE = 'libredb_seed_development'
// SEED_USER_PASSWORD of this run: every user the development seed creates signs in with it.
const SEED_USER_PASSWORD = 'a development password'

describe('seedDevelopment', () => {
  let seedProduction: typeof import('./production').seedProduction
  let seedDevelopment: typeof import('./development').seedDevelopment
  let ConfigErrorClass: typeof import('../../src/shared/lib/errors').ConfigError
  let authorizeCredentials: typeof import('../../src/shared/lib/identity/authorize-credentials').authorizeCredentials
  let db: typeof import('../../src/shared/lib/db').db
  let superuser: Client
  let studio: Client

  async function rows<T extends Record<string, unknown>>(client: Client, sql: string): Promise<T[]> {
    return (await client.query<T>(sql)).rows
  }

  beforeAll(async () => {
    await createFreshDatabase(DATABASE)
    // A fresh module graph, so the seeds' Prisma clients read this database's DATABASE_URL when they load.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform', DATABASE)}?schema=platform`)
    vi.stubEnv('SEED_STUDIO_DATABASE_URL', fixtureUrl('studio', DATABASE))
    vi.stubEnv('SEED_USER_PASSWORD', SEED_USER_PASSWORD)
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAIL', undefined)
    vi.stubEnv('BOOTSTRAP_ADMIN_PASSWORD', undefined)
    vi.resetModules()
    ;({ seedProduction } = await import('./production'))
    ;({ seedDevelopment } = await import('./development'))
    ;({ ConfigError: ConfigErrorClass } = await import('../../src/shared/lib/errors'))
    ;({ authorizeCredentials } = await import('../../src/shared/lib/identity/authorize-credentials'))
    ;({ db } = await import('../../src/shared/lib/db'))
    superuser = await connectSuperuser(DATABASE)
    studio = await connectStudio(DATABASE)

    await seedProduction()
    await seedDevelopment()
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await db?.$disconnect()
    await superuser?.end()
    await studio?.end()
  })

  // The sign-in of a cloud install reads the roles of the user's default membership.
  it('signs in admin@libredb.example as PLATFORM_ADMIN and devops@libredb.example as PLATFORM_TECH of the platform tenant', async () => {
    for (const [email, role] of [
      ['admin@libredb.example', 'PLATFORM_ADMIN'],
      ['devops@libredb.example', 'PLATFORM_TECH'],
    ]) {
      const signedIn = await authorizeCredentials(db, { email, password: SEED_USER_PASSWORD })

      expect(signedIn, email).toMatchObject({
        email,
        roles: [role],
        accessibleTenants: [expect.objectContaining({ slug: 'libredb-platform' })],
      })
    }
  })

  it('the development seed creates sealed connections that bridge.connections_v1 shows and writes no legacy connection', async () => {
    const { kid } = developmentSealKeyPair()
    const published = await rows<{ name: string; engine: string; read_secret: string; write_secret: string | null }>(
      studio,
      'SELECT name, engine, read_secret, write_secret FROM bridge.connections_v1 ORDER BY name',
    )

    expect(published.map((row) => [row.name, row.engine])).toEqual(
      CONNECTIONS.map((c) => [c.name, c.engine]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    )
    for (const row of published) {
      expect(row.read_secret).toMatch(new RegExp(`^lsb1\\.${kid}\\.`))
      if (row.write_secret !== null) expect(row.write_secret).toMatch(new RegExp(`^lsb1\\.${kid}\\.`))
    }
    expect(published.some((row) => row.write_secret !== null)).toBe(true)
  })

  it('the sample query events carry the bare ids of the seeded connections', async () => {
    const events = await rows<{ connection_id: string; known: boolean }>(
      superuser,
      `SELECT e.connection_id, c.id IS NOT NULL AS known
         FROM bridge.query_event e LEFT JOIN platform.database_connections c ON c.id = e.connection_id`,
    )

    expect(events).toHaveLength(QUERY_EVENTS.length)
    expect(events.every((event) => event.known)).toBe(true)
    expect(events.some((event) => event.connection_id.startsWith('seed:'))).toBe(false)
    const ids = await rows<{ id: string }>(superuser, 'SELECT id FROM platform.database_connections')
    expect(new Set(events.map((event) => event.connection_id)).size).toBeGreaterThan(1)
    expect(ids.map((row) => row.id)).toEqual(expect.arrayContaining([...new Set(events.map((e) => e.connection_id))]))
  })

  it('grants the fixture realm users alice and bob on every seeded connection, which bridge.grants_v1 publishes', async () => {
    const alice = '00000000-0000-4000-8000-00000000a11c'
    const bob = '00000000-0000-4000-8000-000000000b0b'
    const published = await rows<{ subject: string; name: string; level: string; downgraded: boolean }>(
      studio,
      `SELECT g.subject, c.name, g.level, g.downgraded
         FROM bridge.grants_v1 g JOIN bridge.connections_v1 c ON c.connection_id = g.connection_id`,
    )

    expect(published).toHaveLength(CONNECTIONS.length * 2)
    for (const c of CONNECTIONS) {
      const of = (subject: string) => published.find((row) => row.subject === subject && row.name === c.name)
      expect(of(alice)).toMatchObject({ level: c.writeCredential ? 'write' : 'read', downgraded: false })
      expect(of(bob)).toMatchObject({ level: 'read', downgraded: false })
    }
  })

  it('seeds the support fixtures as tickets of sarah.chen@acme.test in Acme Corp and tom.reed@startuplabs.test in Startup Labs', async () => {
    const fixtures = await rows<{ ticketNumber: string; tenant: string; customer: string; status: string }>(
      superuser,
      `SELECT t."ticketNumber", tn.slug AS tenant, u.email AS customer, t.status
         FROM platform.support_tickets t
         JOIN platform.tenants tn ON tn.id = t."tenantId"
         JOIN platform.users u ON u.id = t."createdByUserId"
        WHERE t."ticketNumber" LIKE 'TKT-SEED-%'
        ORDER BY t."ticketNumber"`,
    )

    expect(fixtures).toEqual([
      { ticketNumber: 'TKT-SEED-001', tenant: 'acme-corp', customer: 'sarah.chen@acme.test', status: 'OPEN' },
      { ticketNumber: 'TKT-SEED-002', tenant: 'acme-corp', customer: 'sarah.chen@acme.test', status: 'RESOLVED' },
      { ticketNumber: 'TKT-SEED-003', tenant: 'startup-labs', customer: 'tom.reed@startuplabs.test', status: 'IN_PROGRESS' },
    ])
  })

  // The seed leaves a sample ticket unassigned, without an error, when no seeded user has its assignee's address.
  it('assigns the sample tickets to the platform users admin@libredb.example and devops@libredb.example', async () => {
    const assignees = await rows<{ ticketNumber: string; agent: string | null }>(
      superuser,
      `SELECT t."ticketNumber", a.email AS agent
         FROM platform.support_tickets t
         LEFT JOIN platform.users a ON a.id = t."assignedToUserId"
        WHERE t."ticketNumber" LIKE 'TK-%'
        ORDER BY t."ticketNumber"`,
    )

    expect(assignees).toEqual([
      { ticketNumber: 'TK-1001', agent: 'admin@libredb.example' },
      { ticketNumber: 'TK-1002', agent: null },
      { ticketNumber: 'TK-1003', agent: 'devops@libredb.example' },
      { ticketNumber: 'TK-1004', agent: null },
      { ticketNumber: 'TK-1005', agent: 'devops@libredb.example' },
      { ticketNumber: 'TK-1006', agent: null },
    ])
  })

  it('a second run adds no connection, no grant, no query event, no membership and no role', async () => {
    const count = `SELECT (SELECT count(*)::int FROM platform.database_connections) AS connections,
                          (SELECT count(*)::int FROM platform.connection_grants) AS grants,
                          (SELECT count(*)::int FROM bridge.query_event) AS events,
                          (SELECT count(*)::int FROM platform.tenant_members) AS memberships,
                          (SELECT count(*)::int FROM platform.user_roles) AS roles`
    const before = await rows(superuser, count)

    await seedDevelopment()

    expect(await rows(superuser, count)).toEqual(before)
  })

  it('a missing SEED_STUDIO_DATABASE_URL throws ConfigError', async () => {
    vi.stubEnv('SEED_STUDIO_DATABASE_URL', undefined)
    try {
      const failure = await seedDevelopment().then(() => null, (error: unknown) => error)

      expect(failure).toBeInstanceOf(ConfigErrorClass)
      expect((failure as Error).message).toContain('SEED_STUDIO_DATABASE_URL')
    } finally {
      vi.stubEnv('SEED_STUDIO_DATABASE_URL', fixtureUrl('studio', DATABASE))
    }
  })
})
