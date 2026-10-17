import { db } from '@/shared/lib/db'
import { Prisma } from '@prisma/client'

/** Sanitizes user query into a Postgres to_tsquery expression. Returns null if input is empty. */
export function buildTsQuery(input: string): string | null {
  const cleaned = input
    .replace(/['"\\]/g, '')
    .replace(/[&|!():*<>]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10)
  if (cleaned.length === 0) return null
  return cleaned.map(t => `${t}:*`).join(' & ')
}

export type SearchScope =
  | { mode: 'all' }
  | { mode: 'tenant'; tenantId: string }
  // `tenantId` required to match InboxScope's `own` isolation. Without it
  // a user who belongs to multiple tenants can surface the other tenant's
  // tickets via search, bypassing the tenant boundary that findInbox enforces.
  | { mode: 'own'; userId: string; tenantId: string | null }

export async function searchTickets(
  scope: SearchScope,
  query: string,
  limit = 25,
): Promise<Array<{ id: string; ticketNumber: string; subject: string; rank: number }>> {
  const tsq = buildTsQuery(query)
  if (!tsq) return []

  let scopeSql: Prisma.Sql
  if (scope.mode === 'tenant') {
    scopeSql = Prisma.sql`AND "tenantId" = ${scope.tenantId}`
  } else if (scope.mode === 'own') {
    // Tenant boundary first, then the own-ticket predicate. `null` tenantId
    // is a legitimate value (internal / platform-scope tickets), so we use
    // IS NOT DISTINCT FROM semantics via a conditional branch.
    const tenantClause = scope.tenantId === null
      ? Prisma.sql`AND "tenantId" IS NULL`
      : Prisma.sql`AND "tenantId" = ${scope.tenantId}`
    scopeSql = Prisma.sql`${tenantClause} AND ("createdByUserId" = ${scope.userId} OR "assignedToUserId" = ${scope.userId})`
  } else {
    scopeSql = Prisma.empty
  }

  // Qualified like every Prisma query, so the result never depends on the session's search_path.
  return db.$queryRaw<Array<{ id: string; ticketNumber: string; subject: string; rank: number }>>`
    SELECT id, "ticketNumber", subject,
           ts_rank("searchVector", to_tsquery('simple', ${tsq})) AS rank
    FROM platform.support_tickets
    WHERE "searchVector" @@ to_tsquery('simple', ${tsq})
      ${scopeSql}
    ORDER BY rank DESC, "lastActivityAt" DESC
    LIMIT ${limit}
  `
}
