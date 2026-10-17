import { NextResponse } from 'next/server'
import { requireAuth } from '@/shared/lib/auth-utils'
import { SupportRepository, type InboxScope } from '@/features/support/lib/support.repository'
import { inboxFiltersSchema } from '@/features/support/lib/support.schema'
import { searchTickets, type SearchScope } from '@/features/support/lib/support-search'
import { db } from '@/shared/lib/db'
import { PERMISSIONS } from '@/shared/lib/permissions'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const user = await requireAuth()
  const url = new URL(req.url)
  const filters = inboxFiltersSchema.parse({
    view: url.searchParams.get('view') ?? 'open',
    priority: url.searchParams.getAll('priority'),
    tags: url.searchParams.getAll('tag'),
    q: url.searchParams.get('q') ?? undefined,
    assignee: url.searchParams.get('assignee') ?? undefined,
    limit: Number(url.searchParams.get('limit') ?? 50),
  })

  // Thread the viewer's userId into every scope so "mine" view + assignee=me
  // filter work at tenant and platform level too, not just "own".
  const scope: InboxScope =
    user.permissions.includes(PERMISSIONS.TICKET_VIEW_ALL)
      ? { mode: 'all', userId: user.id }
    : user.permissions.includes(PERMISSIONS.TICKET_VIEW_TENANT) && user.currentTenantId
      ? { mode: 'tenant', tenantId: user.currentTenantId, userId: user.id }
    : { mode: 'own', userId: user.id, tenantId: user.currentTenantId ?? null }

  if (filters.q && filters.q.length > 0) {
    // Thread tenantId into the "own" search scope so results stay inside
    // the current tenant, matching findInbox isolation.
    const searchScope: SearchScope =
      scope.mode === 'all' ? { mode: 'all' }
      : scope.mode === 'tenant' ? { mode: 'tenant', tenantId: scope.tenantId }
      : { mode: 'own', userId: scope.userId, tenantId: scope.tenantId }
    const matched = await searchTickets(searchScope, filters.q, filters.limit)
    const matchedIds = matched.map(r => r.id)
    if (matchedIds.length === 0) return NextResponse.json({ tickets: [] })
    const tickets = await db.supportTicket.findMany({
      where: { id: { in: matchedIds } },
      include: { tags: { include: { tag: true } } },
    })
    const byId = new Map(tickets.map(t => [t.id, t]))
    const ordered = matchedIds.map(id => byId.get(id)).filter(Boolean)
    return NextResponse.json({ tickets: ordered })
  }

  const tickets = await SupportRepository.findInbox(scope, filters)
  return NextResponse.json({ tickets })
}
