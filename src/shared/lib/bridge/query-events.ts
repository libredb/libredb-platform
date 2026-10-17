import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { db } from '@/shared/lib/db'
import { isSelfHosted } from '@/shared/lib/deployment'
import { ValidationError } from '@/shared/lib/errors'
import {
  QUERY_EVENT_STATEMENT_TYPES,
  QUERY_EVENT_STATUSES,
  type QueryEventCapture,
  type QueryEventStatus,
} from './query-event-vocabulary'

export * from './query-event-vocabulary'

// Reads the query events that Studio writes.
// The runtime role has SELECT on bridge.query_event and not on the insert-only view bridge.query_events_v1, so this reads the table.
// The bridge carries no tenant column: an event belongs to the tenant of the Platform connection whose id equals its connection_id.

export const QUERY_EVENT_LIMIT_MAX = 200
export const QUERY_EVENT_LIMIT_DEFAULT = 50

/** The label of an event whose connection_id matches no Platform connection, which only self-hosted mode lists. */
export const UNKNOWN_CONNECTION_LABEL = 'unknown connection'

export const queryEventFiltersSchema = z.object({
  tenantId: z.string().min(1),
  subject: z.string().min(1).max(512).optional(),
  connectionId: z.string().min(1).max(64).optional(),
  source: z
    .string()
    .regex(/^[a-z][a-z-]{0,31}$/)
    .optional(),
  statementType: z.enum(QUERY_EVENT_STATEMENT_TYPES).optional(),
  status: z.enum(QUERY_EVENT_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(QUERY_EVENT_LIMIT_MAX).default(QUERY_EVENT_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
})

export type QueryEventFilters = z.input<typeof queryEventFiltersSchema>

export interface QueryEvent {
  eventId: string
  startedAt: Date
  finishedAt: Date
  subject: string
  username: string | null
  sessionRole: string
  connectionId: string
  /** False when connection_id matches no Platform connection; connectionName is then UNKNOWN_CONNECTION_LABEL. */
  connectionKnown: boolean
  connectionName: string
  /** The engine of the Platform connection, or the engine Studio recorded for an unknown connection. */
  engine: string | null
  accessLevel: string | null
  source: string
  statementType: string
  explain: string | null
  statementCapture: QueryEventCapture
  statement: string | null
  statementTruncated: boolean
  rowCount: number | null
  durationMs: number
  status: QueryEventStatus
  errorCode: string | null
  errorMessage: string | null
  transactionOutcome: string | null
}

export interface QueryEventStats {
  total: number
  today: number
  errors: number
}

export interface QueryEventSubject {
  subject: string
  username: string | null
}

interface QueryEventRow {
  event_id: string
  started_at: Date
  finished_at: Date
  subject: string
  username: string | null
  session_role: string
  connection_id: string
  platform_connection_id: string | null
  platform_connection_name: string | null
  platform_engine: string | null
  engine: string | null
  access_level: string | null
  source: string
  statement_type: string
  explain: string | null
  statement_capture: QueryEvent['statementCapture']
  statement: string | null
  statement_truncated: boolean
  row_count: bigint | number | null
  duration_ms: number
  status: QueryEvent['status']
  error_code: string | null
  error_message: string | null
  transaction_outcome: string | null
}

const FROM_EVENTS = Prisma.sql`
  FROM "bridge"."query_event" e
  LEFT JOIN "platform"."database_connections" c ON c."id" = e."connection_id"`

/**
 * Keeps the events on connections of the tenant and, in self-hosted mode, the events whose connection_id matches no Platform
 * connection, such as refused requests for unknown ids. A self-hosted install has one tenant, so those belong to it.
 */
function tenantScope(tenantId: string): Prisma.Sql {
  return isSelfHosted()
    ? Prisma.sql`(c."tenantId" = ${tenantId} OR c."id" IS NULL)`
    : Prisma.sql`c."tenantId" = ${tenantId}`
}

/** Escapes the LIKE wildcards, so a search matches its text literally. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, '\\$&')}%`
}

function toQueryEvent(row: QueryEventRow): QueryEvent {
  const known = row.platform_connection_id !== null
  return {
    eventId: row.event_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    subject: row.subject,
    username: row.username,
    sessionRole: row.session_role,
    connectionId: row.connection_id,
    connectionKnown: known,
    connectionName: known ? (row.platform_connection_name as string) : UNKNOWN_CONNECTION_LABEL,
    engine: known ? row.platform_engine : row.engine,
    accessLevel: row.access_level,
    source: row.source,
    statementType: row.statement_type,
    explain: row.explain,
    statementCapture: row.statement_capture,
    statement: row.statement,
    statementTruncated: row.statement_truncated,
    rowCount: row.row_count === null ? null : Number(row.row_count),
    durationMs: row.duration_ms,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    transactionOutcome: row.transaction_outcome,
  }
}

function parseFilters(filters: QueryEventFilters): z.output<typeof queryEventFiltersSchema> {
  const result = queryEventFiltersSchema.safeParse(filters)
  if (!result.success) {
    throw new ValidationError(z.flattenError(result.error).fieldErrors as Record<string, string[]>)
  }
  return result.data
}

/** Lists the events of a tenant, newest first, with the number of events that match the filters. */
export async function list(filters: QueryEventFilters): Promise<{ events: QueryEvent[]; total: number }> {
  const f = parseFilters(filters)
  const conditions: Prisma.Sql[] = [tenantScope(f.tenantId)]
  if (f.subject) conditions.push(Prisma.sql`e."subject" = ${f.subject}`)
  if (f.connectionId) conditions.push(Prisma.sql`e."connection_id" = ${f.connectionId}`)
  if (f.source) conditions.push(Prisma.sql`e."source" = ${f.source}`)
  if (f.statementType) conditions.push(Prisma.sql`e."statement_type" = ${f.statementType}`)
  if (f.status) conditions.push(Prisma.sql`e."status" = ${f.status}`)
  if (f.from) conditions.push(Prisma.sql`e."started_at" >= ${f.from}`)
  if (f.to) conditions.push(Prisma.sql`e."started_at" <= ${f.to}`)
  if (f.search) conditions.push(Prisma.sql`e."statement" ILIKE ${likePattern(f.search)}`)
  const where = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`

  const [rows, counts] = await Promise.all([
    db.$queryRaw<QueryEventRow[]>`
      SELECT e."event_id"::text AS event_id, e."started_at", e."finished_at", e."subject", e."username", e."session_role",
             e."connection_id", c."id" AS platform_connection_id, c."name" AS platform_connection_name,
             c."engine" AS platform_engine, e."engine", e."access_level", e."source", e."statement_type", e."explain",
             e."statement_capture", e."statement", e."statement_truncated", e."row_count", e."duration_ms", e."status",
             e."error_code", e."error_message", e."transaction_outcome"
      ${FROM_EVENTS}
      ${where}
      ORDER BY e."started_at" DESC, e."event_id" DESC
      LIMIT ${f.limit} OFFSET ${f.offset}`,
    db.$queryRaw<Array<{ total: number }>>`SELECT count(*)::integer AS total ${FROM_EVENTS} ${where}`,
  ])
  return { events: rows.map(toQueryEvent), total: counts[0].total }
}

/** The newest events of a tenant, for activity feeds. */
export async function recent(tenantId: string, limit: number): Promise<QueryEvent[]> {
  const { events } = await list({ tenantId, limit })
  return events
}

/** Counts a tenant's events: all of them, those started since local midnight, and those with status error. */
export async function stats(tenantId: string): Promise<QueryEventStats> {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const [row] = await db.$queryRaw<QueryEventStats[]>`
    SELECT count(*)::integer AS total,
           (count(*) FILTER (WHERE e."started_at" >= ${todayStart}))::integer AS today,
           (count(*) FILTER (WHERE e."status" = 'error'))::integer AS errors
    ${FROM_EVENTS}
    WHERE ${tenantScope(tenantId)}`
  return row
}

/** Every subject with events in the tenant, with the username of its latest event. */
export async function distinctSubjects(tenantId: string): Promise<QueryEventSubject[]> {
  return db.$queryRaw<QueryEventSubject[]>`
    SELECT DISTINCT ON (e."subject") e."subject", e."username"
    ${FROM_EVENTS}
    WHERE ${tenantScope(tenantId)}
    ORDER BY e."subject", e."started_at" DESC`
}

/** Counts the events of every tenant started at or after the date, for the platform administrator. */
export async function countSince(date: Date): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM "bridge"."query_event" WHERE "started_at" >= ${date}`
  return row.count
}
