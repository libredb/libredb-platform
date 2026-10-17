import { Prisma, type SupportTicket } from '@prisma/client'
import { db } from '@/shared/lib/db'
import { NotFoundError } from '@/shared/lib/errors'
import type { CreateTicketData, UpdateTicketData, InboxFilters } from './support.schema'

/**
 * True when the error is a Prisma P2002 unique-constraint violation on the
 * `support_tickets` composite (tenantId, ticketNumber) index, the signal
 * that two concurrent creates picked the same sequence number. Prisma 7
 * names the violated columns through the driver adapter, quoted as
 * PostgreSQL prints them, and no longer in `meta.target`.
 */
function isTicketNumberCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (err.code !== 'P2002') return false
  const adapterError = err.meta?.driverAdapterError as { cause?: { constraint?: { fields?: unknown } } } | undefined
  const fields = adapterError?.cause?.constraint?.fields
  return Array.isArray(fields) && fields.some(field => field === '"ticketNumber"')
}

export type InboxScope =
  | { mode: 'all'; userId?: string }
  // `userId` is optional on tenant scope: when present, the "mine" view
  // and `assignee=me` filter will work for tenant-level viewers too (they
  // were previously no-ops outside of "own" mode).
  | { mode: 'tenant'; tenantId: string; userId?: string }
  | { mode: 'own'; userId: string; tenantId: string | null }

export class SupportRepository {
  static async findInbox(scope: InboxScope, filters: InboxFilters) {
    const where: any = {}

    if (scope.mode === 'tenant') where.tenantId = scope.tenantId
    if (scope.mode === 'own') {
      // Tenant isolation: "own" within the current tenant only. When the
      // caller passes tenantId === null we're in a platform/internal context,
      // which still scopes to tenantId: null (internal-only tickets). Without
      // this guard, a user who belongs to multiple tenants would see other
      // tenants' tickets in their "own" inbox view.
      where.tenantId = scope.tenantId
      where.OR = [
        { createdByUserId: scope.userId },
        { assignedToUserId: scope.userId },
      ]
    }

    // Viewer id used by "mine" view + assignee=me filter. Falls back to
    // undefined when scope doesn't identify a viewer (e.g. mode='all' without
    // userId), in which case these filters become no-ops.
    const viewerId =
      scope.mode === 'own' ? scope.userId :
      scope.mode === 'tenant' ? scope.userId :
      scope.mode === 'all' ? scope.userId :
      undefined

    switch (filters.view) {
      case 'open': where.status = { in: ['OPEN', 'IN_PROGRESS'] }; break
      case 'closed': where.status = { in: ['RESOLVED', 'CLOSED'] }; break
      case 'mine':
        if (viewerId) where.assignedToUserId = viewerId
        break
      case 'unassigned': where.assignedToUserId = null; break
      case 'high': where.priority = { in: ['HIGH', 'URGENT'] }; break
      case 'all': break
    }

    if (filters.priority?.length) where.priority = { in: filters.priority }
    if (filters.assignee === 'me' && viewerId) where.assignedToUserId = viewerId
    if (filters.assignee && filters.assignee !== 'me' && filters.assignee !== 'null') {
      where.assignedToUserId = filters.assignee
    }
    if (filters.assignee === 'null') where.assignedToUserId = null

    if (filters.tags?.length) {
      where.tags = { some: { tagId: { in: filters.tags } } }
    }

    return db.supportTicket.findMany({
      where,
      orderBy: { lastActivityAt: 'desc' },
      take: filters.limit,
      include: {
        tags: { include: { tag: true } },
      },
    })
  }

  static async findById(id: string) {
    const ticket = await db.supportTicket.findUnique({
      where: { id },
      include: {
        messages: {
          include: { attachments: true },
          orderBy: { createdAt: 'asc' },
        },
        activities: {
          orderBy: { createdAt: 'asc' },
        },
        tags: { include: { tag: true } },
      },
    })
    if (!ticket) throw new NotFoundError('SupportTicket')
    return ticket
  }

  /**
   * @deprecated Prefer `createWithAutoNumber` so ticket-number allocation
   * and ticket creation happen together with collision retry. Left for the
   * legacy `create()` path below; will be removed with that method.
   */
  static async getNextTicketNumber(tenantId: string | null): Promise<string> {
    const prefix = tenantId ? 'TKT' : 'INT'
    const count = await db.supportTicket.count({ where: { tenantId } })
    return `${prefix}-${String(count + 1).padStart(4, '0')}`
  }

  /**
   * Allocate a per-tenant ticket number and create the ticket inside a
   * single transaction, retrying on unique-constraint collisions from
   * concurrent creates. Returns whatever the callback returns, so callers
   * can also create related rows (first message, attachments) inside the
   * same transaction.
   *
   * Each attempt picks `count+1+attempt` as a pragmatic backoff: five
   * concurrent creates will serialize without human-visible delay. After
   * five attempts we surface the original Prisma error so it isn't masked.
   */
  static async createWithAutoNumber<T>(
    tenantId: string | null,
    fn: (ticketNumber: string, tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const prefix = tenantId ? 'TKT' : 'INT'
    const MAX_ATTEMPTS = 5
    let lastError: unknown

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const count = await db.supportTicket.count({ where: { tenantId } })
      const ticketNumber = `${prefix}-${String(count + 1 + attempt).padStart(4, '0')}`
      try {
        return await db.$transaction((tx) => fn(ticketNumber, tx))
      } catch (err) {
        if (isTicketNumberCollision(err)) {
          lastError = err
          continue
        }
        throw err
      }
    }
    throw lastError ?? new Error('Ticket number allocation failed after retries')
  }

  static async getReferenceValues(typeCode: string) {
    return db.referenceValue.findMany({
      where: { referenceType: { code: typeCode }, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, code: true, name: true, colorCode: true, icon: true },
    })
  }

  static async getUsersByIds(userIds: string[]) {
    if (userIds.length === 0) return []
    return db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    })
  }

  static async listAccessibleTags(tenantId: string | null) {
    return db.supportTag.findMany({
      where: {
        OR: [
          { tenantId: null },
          ...(tenantId ? [{ tenantId }] : []),
        ],
      },
      orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
    })
  }

  static async searchPlatformStaff(query: string) {
    // User → memberships (TenantMember[]) → roles (UserRole[]) → role (Role) → code
    return db.user.findMany({
      where: {
        AND: [
          ...(query ? [{
            OR: [
              { name: { contains: query, mode: 'insensitive' as const } },
              { email: { contains: query, mode: 'insensitive' as const } },
            ],
          }] : []),
          {
            memberships: {
              some: {
                roles: {
                  some: {
                    role: { code: { in: ['PLATFORM_ADMIN', 'PLATFORM_TECH', 'PLATFORM_SUPPORT'] } },
                  },
                },
              },
            },
          },
        ],
      },
      select: { id: true, name: true, email: true },
      take: 10,
    })
  }

  // ─── Legacy aliases (deprecated, and no longer called) ───

  /** @deprecated use findInbox, as the inbox route does */
  static async findByTenant(
    tenantId: string,
    options?: { userId?: string; status?: string; priority?: string; category?: string },
  ) {
    return this.findInbox(
      { mode: 'tenant', tenantId },
      { view: options?.status ? 'all' : 'open', limit: 100 } as any,
    )
  }

  /** @deprecated legacy create; use createWithAutoNumber, as the create-ticket action does */
  static async create(tenantId: string, userId: string, data: CreateTicketData) {
    const ticketNumber = await this.getNextTicketNumber(tenantId)

    return db.supportTicket.create({
      data: {
        tenantId,
        ticketNumber,
        subject: data.subject,
        descriptionRich: data.descriptionRich,
        descriptionPlain: data.descriptionPlain,
        status: 'OPEN',
        priority: data.priority,
        category: data.category,
        createdByUserId: userId,
      },
    })
  }

  /** @deprecated legacy update; the update-ticket action updates the ticket and its activity in one transaction */
  static async update(id: string, data: UpdateTicketData) {
    const updateData: Record<string, unknown> = {}

    if (data.status !== undefined) {
      updateData.status = data.status
      if (data.status === 'RESOLVED') {
        updateData.resolvedAt = new Date()
      }
      if (data.status === 'CLOSED') {
        updateData.closedAt = new Date()
      }
    }
    if (data.priority !== undefined) {
      updateData.priority = data.priority
    }
    if (data.category !== undefined) {
      updateData.category = data.category
    }
    if (data.assignedToUserId !== undefined) {
      updateData.assignedToUserId = data.assignedToUserId
    }

    return db.supportTicket.update({
      where: { id },
      data: updateData,
    })
  }

  /** @deprecated legacy addMessage; the send-message action creates the message and its attachments together */
  static async addMessage(
    ticketId: string,
    userId: string,
    bodyRich: string,
    isInternal: boolean = false,
  ) {
    return db.supportMessage.create({
      data: {
        ticketId,
        senderUserId: userId,
        bodyRich,
        isInternal,
      },
    })
  }

  /** @deprecated legacy messages query; findById returns the messages with the ticket */
  static async getMessages(ticketId: string) {
    return db.supportMessage.findMany({
      where: { ticketId },
      include: { attachments: true },
      orderBy: { createdAt: 'asc' },
    })
  }

  /** @deprecated legacy tenant members for assignee dropdown; use searchPlatformStaff for new code */
  static async getTenantMembers(tenantId: string) {
    return db.tenantMember.findMany({
      where: { tenantId, active: true },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }
}
