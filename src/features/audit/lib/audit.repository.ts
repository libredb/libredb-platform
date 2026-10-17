import { db } from '@/shared/lib/db'
import * as queryEvents from '@/shared/lib/bridge/query-events'
import type { QueryEventFilters } from '@/shared/lib/bridge/query-events'

export type AuditFilters = QueryEventFilters

/** The audit pages read the query events that Studio writes to the bridge. */
export class AuditRepository {
  static async findAll(filters: AuditFilters) {
    return queryEvents.list(filters)
  }

  static async getStats(tenantId: string) {
    return queryEvents.stats(tenantId)
  }

  static async getDistinctSubjects(tenantId: string) {
    return queryEvents.distinctSubjects(tenantId)
  }

  /** The tenant's connections, for the connection filter. */
  static async getConnections(tenantId: string) {
    return db.databaseConnection.findMany({
      where: { tenantId },
      select: { id: true, name: true, engine: true },
      orderBy: { name: 'asc' },
    })
  }
}
