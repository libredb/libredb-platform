import { randomBytes, randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectStudio, connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { ValidationError } from '@/shared/lib/errors'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

// Every row of this file carries this marker in its ids or subjects, so the cleanup removes exactly them.
const MARKER = `query-events-${randomUUID().slice(0, 8)}`
const PLAN_ID = `${MARKER}-plan`
const USER_ID = `${MARKER}-user`
const TENANT_A = `${MARKER}-tenant-a`
const TENANT_B = `${MARKER}-tenant-b`
const ALICE = `${MARKER}-alice`
const BOB = `${MARKER}-bob`

type Event = Record<string, unknown>

// Random bytes in the lsb1 envelope format; the database checks only its format.
function envelope(): string {
  return `lsb1.${randomBytes(8).toString('hex')}.${randomBytes(32).toString('base64url')}.${randomBytes(40).toString('base64url')}`
}

// A successful SELECT with a redacted statement, as Studio inserts it through bridge.query_events_v1.
function queryEvent(overrides: Event = {}): Event {
  const startedAt = (overrides.started_at as Date | undefined) ?? new Date(Date.now() - MINUTE_MS)
  return {
    event_id: randomUUID(),
    started_at: startedAt,
    finished_at: new Date(startedAt.getTime() + 42),
    studio_instance: 'libredb-studio',
    subject: ALICE,
    username: 'alice',
    session_role: 'user',
    connection_id: randomUUID(),
    engine: 'postgres',
    access_level: 'read',
    source: 'editor',
    statement_type: 'SELECT',
    statement_capture: 'redacted',
    statement: 'SELECT id FROM orders WHERE id = ?',
    statement_fingerprint: randomBytes(32).toString('hex'),
    row_count: 1,
    duration_ms: 42,
    status: 'success',
    error_message: null,
    transaction_outcome: null,
    ...overrides,
  }
}

describe('query event reader on PostgreSQL', () => {
  let reader: typeof import('./query-events')
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client
  let studio: Client
  // The bare connection ids that Studio writes, as bridge.connections_v1 publishes them, one connection per tenant.
  const connectionA = randomUUID()
  const connectionA2 = randomUUID()
  const connectionB = randomUUID()

  async function insertConnection(id: string, tenantId: string, name: string, engine: string): Promise<void> {
    await superuser.query(
      `INSERT INTO platform.database_connections (id, "tenantId", name, engine, definition, "readSecret", "createdById")
       VALUES ($1, $2, $3, $4, '{"host": "db.internal"}', $5, $6)`,
      [id, tenantId, name, engine, envelope(), USER_ID],
    )
  }

  async function insertEvents(...events: Event[]): Promise<string[]> {
    for (const event of events) {
      const columns = Object.keys(event)
      await studio.query(
        `INSERT INTO "bridge".query_events_v1 (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map((column) => event[column]),
      )
    }
    return events.map((event) => event.event_id as string)
  }

  async function ids(filters: Parameters<typeof reader.list>[0]): Promise<string[]> {
    const { events } = await reader.list(filters)
    return events.map((event) => event.eventId)
  }

  beforeAll(async () => {
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    reader = await import('./query-events')
    superuser = await connectSuperuser()
    studio = await connectStudio()

    await superuser.query(`INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, $1, 'Probe', now())`, [PLAN_ID])
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'A', $1, $3, now()), ($2, 'B', $2, $3, now())`,
      [TENANT_A, TENANT_B, PLAN_ID],
    )
    await superuser.query(`INSERT INTO platform.users (id, email, "updatedAt") VALUES ($1, 'probe@libredb.test', now())`, [USER_ID])
    await insertConnection(connectionA, TENANT_A, 'Orders', 'postgres')
    await insertConnection(connectionA2, TENANT_A, 'Cache', 'redis')
    await insertConnection(connectionB, TENANT_B, 'Billing', 'mysql')
  })

  afterEach(() => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM bridge.query_event WHERE subject LIKE $1', [`${MARKER}-%`])
    await superuser.query('DELETE FROM platform.database_connections WHERE "createdById" = $1', [USER_ID])
    await superuser.query('DELETE FROM platform.users WHERE id = $1', [USER_ID])
    await superuser.query('DELETE FROM platform.tenants WHERE id IN ($1, $2)', [TENANT_A, TENANT_B])
    await superuser.query('DELETE FROM platform.plan_configs WHERE id = $1', [PLAN_ID])
    await superuser.end()
    await studio.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('lists only events on connections of the session tenant, joined on the bare connection id', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    const subject = `${MARKER}-join`
    const [onA, onB, prefixed] = await insertEvents(
      queryEvent({ subject, connection_id: connectionA, connection_name: 'Studio name' }),
      queryEvent({ subject, connection_id: connectionB, engine: 'mysql' }),
      // Studio's internal seed: prefix never reaches the bridge, so such an id joins no connection.
      queryEvent({ subject, connection_id: `seed:${connectionA}` }),
    )

    const { events, total } = await reader.list({ tenantId: TENANT_A, subject })
    expect(events.map((event) => event.eventId)).toEqual([onA])
    expect(total).toBe(1)
    expect(events[0]).toMatchObject({
      connectionId: connectionA,
      connectionKnown: true,
      connectionName: 'Orders',
      engine: 'postgres',
      subject,
      username: 'alice',
      source: 'editor',
      statementType: 'SELECT',
      statementCapture: 'redacted',
      statement: 'SELECT id FROM orders WHERE id = ?',
      rowCount: 1,
      durationMs: 42,
      status: 'success',
    })
    expect(events[0].startedAt).toBeInstanceOf(Date)

    expect(await ids({ tenantId: TENANT_B, subject })).toEqual([onB])
    expect(await ids({ tenantId: TENANT_A, subject })).not.toContain(prefixed)
  })

  it('includes events for unknown connection ids in self-hosted mode only', async () => {
    const subject = `${MARKER}-unknown`
    const [known, refused] = await insertEvents(
      queryEvent({ subject, connection_id: connectionA, started_at: new Date(Date.now() - 2 * MINUTE_MS) }),
      queryEvent({
        subject,
        connection_id: 'no-such-connection',
        engine: null,
        access_level: null,
        status: 'refused',
        statement_capture: 'none',
        statement: null,
        statement_fingerprint: null,
        row_count: null,
      }),
    )

    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    expect(await ids({ tenantId: TENANT_A, subject })).toEqual([known])

    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
    const { events } = await reader.list({ tenantId: TENANT_A, subject })
    expect(events.map((event) => event.eventId)).toEqual([refused, known])
    expect(events[0]).toMatchObject({
      connectionId: 'no-such-connection',
      connectionKnown: false,
      connectionName: reader.UNKNOWN_CONNECTION_LABEL,
      engine: null,
      status: 'refused',
      statementCapture: 'none',
      statement: null,
    })
    expect(reader.UNKNOWN_CONNECTION_LABEL).toBe('unknown connection')
  })

  it('filters by subject, connection, source, statement type, status and time range', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    const now = Date.now()
    const [base, bob, cache, profile, insert, failed, old] = await insertEvents(
      queryEvent({ connection_id: connectionA, started_at: new Date(now - 1 * MINUTE_MS) }),
      queryEvent({ subject: BOB, username: 'bob', connection_id: connectionA, started_at: new Date(now - 2 * MINUTE_MS) }),
      queryEvent({ connection_id: connectionA2, engine: 'redis', source: 'key-scan', statement_type: 'OTHER', started_at: new Date(now - 3 * MINUTE_MS) }),
      queryEvent({ connection_id: connectionA, source: 'profile', started_at: new Date(now - 4 * MINUTE_MS) }),
      queryEvent({
        connection_id: connectionA,
        statement_type: 'INSERT',
        access_level: 'write',
        statement: 'INSERT INTO audit_100%_done VALUES (?)',
        started_at: new Date(now - 5 * MINUTE_MS),
      }),
      queryEvent({
        connection_id: connectionA,
        status: 'error',
        statement_capture: 'full',
        statement: 'SELECT * FROM missing',
        error_message: 'relation "missing" does not exist',
        started_at: new Date(now - 6 * MINUTE_MS),
      }),
      queryEvent({ connection_id: connectionA, started_at: new Date(now - 3 * DAY_MS) }),
    )
    const mine = [base, cache, profile, insert, failed, old]

    expect(await ids({ tenantId: TENANT_A, subject: ALICE })).toEqual(mine)
    expect(await ids({ tenantId: TENANT_A, subject: BOB })).toEqual([bob])
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, connectionId: connectionA2 })).toEqual([cache])
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, source: 'profile' })).toEqual([profile])
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, source: 'key-scan' })).toEqual([cache])
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, statementType: 'INSERT' })).toEqual([insert])
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, status: 'error' })).toEqual([failed])
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, from: new Date(now - DAY_MS) })).toEqual(mine.slice(0, 5))
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, to: new Date(now - DAY_MS) })).toEqual([old])
    expect(
      await ids({ tenantId: TENANT_A, subject: ALICE, from: new Date(now - 4.5 * MINUTE_MS), to: new Date(now - 2.5 * MINUTE_MS) }),
    ).toEqual([cache, profile])

    // The search matches captured statements case-insensitively and treats LIKE wildcards literally.
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, search: 'missing' })).toEqual([failed])
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, search: '100%_DONE' })).toEqual([insert])
    expect(await ids({ tenantId: TENANT_A, subject: ALICE, search: '0%' })).toEqual([insert])

    const page = await reader.list({ tenantId: TENANT_A, subject: ALICE, limit: 2, offset: 2 })
    expect(page.events.map((event) => event.eventId)).toEqual([profile, insert])
    expect(page.total).toBe(6)
    const [errorEvent] = (await reader.list({ tenantId: TENANT_A, subject: ALICE, status: 'error' })).events
    expect(errorEvent.errorMessage).toBe('relation "missing" does not exist')

    expect(await reader.distinctSubjects(TENANT_A)).toEqual(
      expect.arrayContaining([
        { subject: ALICE, username: 'alice' },
        { subject: BOB, username: 'bob' },
      ]),
    )
    expect((await reader.recent(TENANT_A, 2)).map((event) => event.eventId)).toHaveLength(2)
  })

  it('refuses a limit above 200', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    await expect(reader.list({ tenantId: TENANT_A, limit: 201 })).rejects.toThrow(ValidationError)
    await expect(reader.list({ tenantId: TENANT_A, limit: 0 })).rejects.toThrow(ValidationError)
    await expect(reader.list({ tenantId: TENANT_A, offset: -1 })).rejects.toThrow(ValidationError)
    await expect(reader.list({ tenantId: TENANT_A, limit: 200 })).resolves.toMatchObject({ events: expect.any(Array) })
  })

  it('stats count total, today and errors', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    const tenant = `${MARKER}-tenant-stats`
    const connection = randomUUID()
    const subject = `${MARKER}-stats`
    await superuser.query(`INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'S', $1, $2, now())`, [
      tenant,
      PLAN_ID,
    ])
    await insertConnection(connection, tenant, 'Stats', 'postgres')
    try {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const beforeToday = new Date(todayStart.getTime() - DAY_MS)
      const sinceToday = new Date(Math.max(todayStart.getTime() + 1, Date.now() - MINUTE_MS))
      const before = await reader.countSince(todayStart)
      await insertEvents(
        queryEvent({ subject, connection_id: connection, started_at: sinceToday }),
        queryEvent({ subject, connection_id: connection, started_at: sinceToday, status: 'error' }),
        queryEvent({ subject, connection_id: connection, started_at: beforeToday, status: 'error' }),
        queryEvent({ subject, connection_id: connection, started_at: beforeToday }),
        // An event on another tenant's connection counts for that tenant only.
        queryEvent({ subject, connection_id: connectionB, started_at: sinceToday, status: 'error' }),
      )

      expect(await reader.stats(tenant)).toEqual({ total: 4, today: 2, errors: 2 })
      // countSince is the admin count over every tenant.
      expect((await reader.countSince(todayStart)) - before).toBe(3)
    } finally {
      await superuser.query('DELETE FROM bridge.query_event WHERE subject = $1', [subject])
      await superuser.query('DELETE FROM platform.database_connections WHERE id = $1', [connection])
      await superuser.query('DELETE FROM platform.tenants WHERE id = $1', [tenant])
    }
  })
})
