import { db } from '@/shared/lib/db'
import * as queryEvents from '@/shared/lib/bridge/query-events'

export class AdminStatsRepository {
  static async getStats() {
    const [tenants, users, connections, queriesToday] = await Promise.all([
      db.tenant.count(),
      db.user.count(),
      // Every tenant's connections that are not deleted, as the plan limit counts them.
      db.databaseConnection.count({ where: { deletedAt: null } }),
      queryEvents.countSince(new Date(new Date().setHours(0, 0, 0, 0))),
    ])
    const activeTenants = await db.tenant.count({ where: { active: true } })
    return { tenants, activeTenants, users, connections, queriesToday }
  }

  static async getRecentTenants(limit = 5) {
    return db.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        planConfig: { select: { code: true, name: true } },
        _count: { select: { members: true, connections: { where: { deletedAt: null } } } },
      },
    })
  }
}
