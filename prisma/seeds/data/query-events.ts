import type { QueryEventCapture, QueryEventStatus } from '../../../src/shared/lib/bridge/query-event-vocabulary'

/**
 * A sample query event as Studio records it in bridge.query_events_v1, on a connection of the seed named by its tenant
 * and name. The seed writes the connection's bare id into connection_id and derives a stable event_id, so
 * a second run inserts nothing. The subjects are fictional Keycloak user ids, because the development users sign in
 * with a password.
 */
export interface SeedQueryEvent {
  tenantSlug: string
  connectionName: string
  minutesAgo: number
  subject: string
  username: string
  sessionRole: 'admin' | 'user'
  accessLevel: 'read' | 'write'
  source: string
  statementType: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL' | 'OTHER'
  statementCapture: QueryEventCapture
  statement: string | null
  rowCount: number | null
  durationMs: number
  status: QueryEventStatus
  errorCode?: string
}

const SARAH = { subject: '7d0c2f4e-2b8a-4c61-9a57-1f3e8b6d4a01', username: 'sarah.chen', sessionRole: 'admin' } as const
const JAMES = { subject: '3a9e5b7c-6d1f-4e28-b0c4-8f2a1d6e9b02', username: 'james.wilson', sessionRole: 'user' } as const
const MARIA = { subject: 'c41f8d2a-9e3b-4a75-86d0-2b7e5f1c3a03', username: 'maria.garcia', sessionRole: 'user' } as const
const TOM = { subject: 'e85b1c3d-4f6a-4b92-a7e1-6c9d2f8b0a04', username: 'tom.reed', sessionRole: 'admin' } as const

export const QUERY_EVENTS: SeedQueryEvent[] = [
  // Acme Corp
  {
    tenantSlug: 'acme-corp',
    connectionName: 'Acme Production PG',
    minutesAgo: 12,
    ...JAMES,
    accessLevel: 'read',
    source: 'editor',
    statementType: 'SELECT',
    statementCapture: 'redacted',
    statement: 'SELECT id, email, created_at FROM customers WHERE created_at > ? ORDER BY created_at DESC LIMIT ?',
    rowCount: 50,
    durationMs: 38,
    status: 'success',
  },
  {
    tenantSlug: 'acme-corp',
    connectionName: 'Acme Production PG',
    minutesAgo: 47,
    ...MARIA,
    accessLevel: 'read',
    source: 'editor',
    statementType: 'SELECT',
    statementCapture: 'redacted',
    statement: 'SELECT status, count(*) FROM orders WHERE placed_at >= ? GROUP BY status',
    rowCount: 5,
    durationMs: 214,
    status: 'success',
  },
  {
    tenantSlug: 'acme-corp',
    connectionName: 'Acme Production PG',
    minutesAgo: 95,
    ...SARAH,
    accessLevel: 'write',
    source: 'transaction',
    statementType: 'UPDATE',
    statementCapture: 'redacted',
    statement: 'UPDATE orders SET status = ? WHERE id = ?',
    rowCount: 1,
    durationMs: 17,
    status: 'success',
  },
  {
    tenantSlug: 'acme-corp',
    connectionName: 'Acme Production PG',
    minutesAgo: 130,
    ...JAMES,
    accessLevel: 'read',
    source: 'editor',
    statementType: 'SELECT',
    statementCapture: 'redacted',
    statement: 'SELECT * FROM invoices WHERE total > ?',
    rowCount: null,
    durationMs: 30000,
    status: 'cancelled',
  },
  {
    tenantSlug: 'acme-corp',
    connectionName: 'Acme Staging PG',
    minutesAgo: 180,
    ...MARIA,
    accessLevel: 'write',
    source: 'editor',
    statementType: 'INSERT',
    statementCapture: 'redacted',
    statement: 'INSERT INTO feature_flags (name, enabled) VALUES (?, ?)',
    rowCount: 1,
    durationMs: 9,
    status: 'success',
  },
  {
    tenantSlug: 'acme-corp',
    connectionName: 'Acme Staging PG',
    minutesAgo: 240,
    ...JAMES,
    accessLevel: 'read',
    source: 'editor',
    statementType: 'SELECT',
    statementCapture: 'redacted',
    statement: 'SELECT id, name FROM product_catalogue WHERE sku = ?',
    rowCount: null,
    durationMs: 4,
    status: 'error',
    errorCode: '42P01',
  },
  {
    tenantSlug: 'acme-corp',
    connectionName: 'Acme Analytics MySQL',
    minutesAgo: 360,
    ...SARAH,
    accessLevel: 'read',
    source: 'multi-query',
    statementType: 'SELECT',
    statementCapture: 'redacted',
    statement: 'SELECT DATE(created_at) AS day, COUNT(*) FROM page_views WHERE created_at > ? GROUP BY day',
    rowCount: 30,
    durationMs: 1260,
    status: 'success',
  },
  {
    tenantSlug: 'acme-corp',
    connectionName: 'Acme Cache Redis',
    minutesAgo: 600,
    ...SARAH,
    accessLevel: 'read',
    source: 'key-scan',
    statementType: 'OTHER',
    statementCapture: 'redacted',
    statement: 'SCAN ? MATCH ? COUNT ?',
    rowCount: 100,
    durationMs: 22,
    status: 'success',
  },
  {
    tenantSlug: 'acme-corp',
    connectionName: 'Acme Docs MongoDB',
    minutesAgo: 1500,
    ...JAMES,
    accessLevel: 'write',
    source: 'editor',
    statementType: 'DELETE',
    statementCapture: 'none',
    statement: null,
    rowCount: null,
    durationMs: 0,
    status: 'refused',
  },
  // Startup Labs
  {
    tenantSlug: 'startup-labs',
    connectionName: 'Startup Main PG',
    minutesAgo: 25,
    ...TOM,
    accessLevel: 'read',
    source: 'editor',
    statementType: 'SELECT',
    statementCapture: 'redacted',
    statement: 'SELECT plan, count(*) FROM subscriptions WHERE active = ? GROUP BY plan',
    rowCount: 3,
    durationMs: 56,
    status: 'success',
  },
  {
    tenantSlug: 'startup-labs',
    connectionName: 'Startup Main PG',
    minutesAgo: 2880,
    ...TOM,
    accessLevel: 'write',
    source: 'editor',
    statementType: 'DDL',
    statementCapture: 'redacted',
    statement: 'CREATE INDEX subscriptions_user_id_idx ON subscriptions (user_id)',
    rowCount: null,
    durationMs: 812,
    status: 'success',
  },
]
