import { db } from '@/shared/lib/db'
import { NotFoundError } from '@/shared/lib/errors'
import * as queryEvents from '@/shared/lib/bridge/query-events'
import { hostSummary } from '@/shared/lib/connection-host-summary'
import type { Prisma } from '@prisma/client'

/**
 * "Approaching limit" = used / limit >= 0.8 (and limit is finite, -1 = unlimited).
 * Used when computing the admin dashboard "at limit" KPI. Kept as a constant so
 * we can tune it without hunting through the code.
 */
export const APPROACHING_LIMIT_THRESHOLD = 0.8

type PlanLimits = { maxUsers: number; maxConnections: number }

/** The connections a tenant uses: every one that is not deleted, as the plan limit counts them. */
const NOT_DELETED = { where: { deletedAt: null } } as const

export function isApproachingLimit(
  usage: { members: number; connections: number },
  plan: PlanLimits,
): boolean {
  const memberRatio =
    plan.maxUsers === -1 ? 0 : usage.members / Math.max(plan.maxUsers, 1)
  const connRatio =
    plan.maxConnections === -1
      ? 0
      : usage.connections / Math.max(plan.maxConnections, 1)
  return (
    memberRatio >= APPROACHING_LIMIT_THRESHOLD ||
    connRatio >= APPROACHING_LIMIT_THRESHOLD
  )
}

export class TenantRepository {
  static async findAll(params?: { search?: string; active?: boolean }) {
    const where: Prisma.TenantWhereInput = {}

    if (params?.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { slug: { contains: params.search, mode: 'insensitive' } },
      ]
    }

    if (params?.active !== undefined) {
      where.active = params.active
    }

    return db.tenant.findMany({
      where,
      include: {
        planConfig: {
          select: {
            id: true,
            code: true,
            name: true,
            maxUsers: true,
            maxConnections: true,
          },
        },
        _count: { select: { members: true, connections: NOT_DELETED } },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  /** Basic find, used by forms that only need core tenant fields. */
  static async findById(id: string) {
    const tenant = await db.tenant.findUnique({
      where: { id },
      include: {
        planConfig: true,
        _count: { select: { members: true, connections: NOT_DELETED } },
      },
    })
    if (!tenant) throw new NotFoundError('Tenant')
    return tenant
  }

  /**
   * Rich tenant detail, used by the admin overview page.
   * Includes members, connections, subscription, invitations + counts for
   * unread things like pending invitations and open tickets.
   *
   * Intentionally bounded: we include the *lists* but the separate tabs
   * re-query with pagination when users drill in.
   */
  static async findByIdWithDetails(id: string) {
    const tenant = await db.tenant.findUnique({
      where: { id },
      include: {
        planConfig: true,
        subscription: true,
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
                lastLoginAt: true,
                active: true,
              },
            },
            roles: {
              include: {
                role: { select: { code: true, name: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        // The sealed credentials are never selected, so they never leave the database.
        connections: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            engine: true,
            definition: true,
            active: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        invitations: {
          where: { acceptedAt: null },
          select: { id: true, email: true, expiresAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        _count: {
          select: {
            members: true,
            connections: NOT_DELETED,
            tickets: true,
            sharedQueries: true,
            invitations: true,
          },
        },
      },
    })
    if (!tenant) throw new NotFoundError('Tenant')
    const { connections, _count, ...rest } = tenant
    // Query events live in the bridge and belong to the tenant through their connection.
    const { total: queryEventCount } = await queryEvents.stats(id)
    return {
      ...rest,
      connections: connections.map(({ definition, ...connection }) => ({
        ...connection,
        hostSummary: hostSummary(definition as Prisma.JsonObject),
      })),
      _count: { ..._count, queryEvents: queryEventCount },
    }
  }

  /**
   * Unified activity feed: merges the tenant's query events, SupportTicket, and
   * Invitation events into a single time-ordered stream.
   * Each query is bounded to `limit * 2` to give the merge enough material
   * while keeping the overall work cheap.
   */
  static async findRecentActivity(tenantId: string, limit = 20) {
    const [audits, tickets, invites] = await Promise.all([
      queryEvents.recent(tenantId, limit * 2),
      db.supportTicket.findMany({
        where: { tenantId },
        select: {
          id: true,
          ticketNumber: true,
          subject: true,
          status: true,
          priority: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      }),
      db.invitation.findMany({
        where: { tenantId },
        select: {
          id: true,
          email: true,
          createdAt: true,
          acceptedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ])

    type ActivityItem =
      | {
          kind: 'query'
          id: string
          at: Date
          username: string | null
          subject: string
          statementType: string
          status: string
          connectionName: string
          durationMs: number
        }
      | {
          kind: 'ticket'
          id: string
          at: Date
          ticketNumber: string
          subject: string
          status: string
          priority: string
        }
      | {
          kind: 'invitation'
          id: string
          at: Date
          email: string
          accepted: boolean
        }

    const items: ActivityItem[] = [
      ...audits.map(
        (a): ActivityItem => ({
          kind: 'query',
          id: a.eventId,
          at: a.startedAt,
          username: a.username,
          subject: a.subject,
          statementType: a.statementType,
          status: a.status,
          connectionName: a.connectionName,
          durationMs: a.durationMs,
        }),
      ),
      ...tickets.map(
        (t): ActivityItem => ({
          kind: 'ticket',
          id: t.id,
          at: t.updatedAt,
          ticketNumber: t.ticketNumber,
          subject: t.subject,
          status: t.status,
          priority: t.priority,
        }),
      ),
      ...invites.map(
        (i): ActivityItem => ({
          kind: 'invitation',
          id: i.id,
          at: i.acceptedAt ?? i.createdAt,
          email: i.email,
          accepted: !!i.acceptedAt,
        }),
      ),
    ]

    return items
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit)
  }

  /**
   * Admin KPI stats for the tenant list header.
   * "Approaching limit" is computed in memory because it's a ratio against
   * the tenant's assigned plan: expressing it in SQL would require joining
   * to planConfig and comparing per-row counts.
   */
  static async getAdminStats() {
    const [total, active, inactive, tenantsWithUsage] = await Promise.all([
      db.tenant.count(),
      db.tenant.count({ where: { active: true } }),
      db.tenant.count({ where: { active: false } }),
      db.tenant.findMany({
        where: { active: true },
        select: {
          id: true,
          planConfig: { select: { maxUsers: true, maxConnections: true } },
          _count: { select: { members: true, connections: NOT_DELETED } },
        },
      }),
    ])

    const approachingLimits = tenantsWithUsage.filter((t) =>
      isApproachingLimit(t._count, t.planConfig),
    ).length

    return { total, active, inactive, approachingLimits }
  }

  static async create(data: {
    name: string
    slug: string
    planConfigId: string
  }) {
    return db.tenant.create({ data })
  }

  static async update(
    id: string,
    data: {
      name?: string
      slug?: string
      planConfigId?: string
      active?: boolean
    },
  ) {
    return db.tenant.update({ where: { id }, data })
  }

  static async toggleActive(id: string) {
    const tenant = await db.tenant.findUnique({ where: { id } })
    if (!tenant) throw new NotFoundError('Tenant')
    return db.tenant.update({
      where: { id },
      data: { active: !tenant.active },
    })
  }

  static async findAllPlanConfigs() {
    return db.planConfig.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { id: true, code: true, name: true },
    })
  }
}
