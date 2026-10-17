import { randomBytes, randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectStudio, connectSuperuser, fixtureUrl } from '../../../../../tests/db/connect'
import type { TrimQueryEvents } from './query-event-retention'

const DAY_MS = 24 * 60 * 60 * 1000

// Every event of this file has this subject, so the cleanup removes exactly them.
const SUBJECT = `query-event-retention-${randomUUID()}`

// A successful SELECT that Studio records through bridge.query_events_v1, started the given time ago.
async function insertEventStartedAgo(studio: Client, ms: number): Promise<string> {
  const eventId = randomUUID()
  const startedAt = Date.now() - ms
  await studio.query(
    `INSERT INTO "bridge".query_events_v1 (event_id, started_at, finished_at, studio_instance, subject, username, session_role,
       connection_id, engine, access_level, source, statement_type, statement_capture, statement, statement_fingerprint,
       row_count, duration_ms, status)
     VALUES ($1, $2, $3, 'libredb-studio', $4, 'alice@example.com', 'user', $5, 'postgres', 'read', 'editor', 'SELECT',
       'redacted', 'SELECT 1', $6, 1, 42, 'success')`,
    [eventId, new Date(startedAt), new Date(startedAt + 42), SUBJECT, randomUUID(), randomBytes(32).toString('hex')],
  )
  return eventId
}

describe('query event retention task on PostgreSQL', () => {
  let db: typeof import('@/shared/lib/db').db
  let retention: typeof import('./query-event-retention')
  let studio: Client
  let superuser: Client

  beforeAll(async () => {
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    retention = await import('./query-event-retention')
    studio = await connectStudio()
    superuser = await connectSuperuser()
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM bridge.query_event WHERE subject = $1', [SUBJECT])
    await superuser.end()
    await studio.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  // The real trim through the Prisma client, recording what each call returned.
  function recordingTrim(calls: Array<{ days: number; batch: number; deleted: number }>): TrimQueryEvents {
    const trim = retention.trimQueryEventsWith(db)
    return async (days, batch) => {
      const deleted = await trim(days, batch)
      calls.push({ days, batch, deleted })
      return deleted
    }
  }

  async function remaining(eventIds: string[]): Promise<string[]> {
    const result = await superuser.query<{ event_id: string }>(
      'SELECT event_id FROM bridge.query_event WHERE event_id = ANY($1) ORDER BY started_at',
      [eventIds],
    )
    return result.rows.map(row => row.event_id)
  }

  async function countOlderThan(days: number): Promise<number> {
    const result = await superuser.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM bridge.query_event WHERE started_at < now() - make_interval(days => $1)`,
      [days],
    )
    return result.rows[0].count
  }

  it('deletes events older than the retention in batches until a short batch', async () => {
    const expired = []
    for (let index = 0; index < 5; index += 1) expired.push(await insertEventStartedAgo(studio, (200 + index) * DAY_MS))
    const kept = await insertEventStartedAgo(studio, 30 * DAY_MS)
    const expiredBefore = await countOlderThan(90)
    expect(expiredBefore).toBeGreaterThanOrEqual(expired.length)

    const calls: Array<{ days: number; batch: number; deleted: number }> = []
    const task = retention.createQueryEventRetentionTask({ trim: recordingTrim(calls), retentionDays: () => 90, batch: 2 })
    await task.run({ state: null })

    expect(calls.every(call => call.days === 90 && call.batch === 2)).toBe(true)
    // Every call but the last returned a full batch, and the last a short one.
    expect(calls.slice(0, -1).every(call => call.deleted === 2)).toBe(true)
    expect(calls.at(-1)!.deleted).toBeLessThan(2)
    expect(calls.reduce((sum, call) => sum + call.deleted, 0)).toBe(expiredBefore)
    expect(calls.length).toBe(Math.floor(expiredBefore / 2) + 1)

    expect(await countOlderThan(90)).toBe(0)
    expect(await remaining([...expired, kept])).toEqual([kept])
  })

  it('keeps every event younger than 7 days even with QUERY_LOG_RETENTION_DAYS=1', async () => {
    const young = [await insertEventStartedAgo(studio, 6 * DAY_MS), await insertEventStartedAgo(studio, 2 * DAY_MS)]
    const weekOld = await insertEventStartedAgo(studio, 8 * DAY_MS)
    const { readRuntimeConfig } = await import('@/shared/lib/runtime-config')
    const config = readRuntimeConfig({
      DEPLOYMENT_MODE: 'cloud',
      DATABASE_URL: `${fixtureUrl('platform')}?schema=platform`,
      AUTH_SECRET: 'auth-secret-value-of-at-least-32-characters',
      QUERY_LOG_RETENTION_DAYS: '1',
    })

    const calls: Array<{ days: number; batch: number; deleted: number }> = []
    const task = retention.createQueryEventRetentionTask({
      trim: recordingTrim(calls),
      retentionDays: () => config.QUERY_LOG_RETENTION_DAYS,
    })
    await task.run({ state: null })

    expect(calls.map(call => [call.days, call.batch])).toEqual([[1, 10_000]])
    expect(await remaining([...young, weekOld])).toEqual(young)
    expect(await countOlderThan(7)).toBe(0)
  })
})
