import { requireAuth } from '@/shared/lib/auth-utils'
import { db } from '@/shared/lib/db'
import { SupportRepository } from '@/features/support/lib/support.repository'
import { canViewTicket, canManageTicket, canSeeInternalNotes, tenantPageHref } from '@/features/support/lib/support-permissions'
import { ConversationView } from '@/features/support/components/conversation-view'
import { getDeploymentMode } from '@/shared/lib/deployment'
import { notFound, redirect } from 'next/navigation'

export default async function TicketDetailPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const user = await requireAuth()
  const { id } = await params
  const ticket = await SupportRepository.findById(id).catch(() => null)
  if (!ticket) notFound()
  if (!canViewTicket(user, ticket)) redirect('/support')

  const canManage = canManageTicket(user, ticket)
  const canSeeInternal = canSeeInternalNotes(user)

  const [statusValues, priorityValues, categoryValues, availableTags] = await Promise.all([
    SupportRepository.getReferenceValues('TICKET_STATUS'),
    SupportRepository.getReferenceValues('TICKET_PRIORITY'),
    SupportRepository.getReferenceValues('TICKET_CATEGORY'),
    SupportRepository.listAccessibleTags(user.currentTenantId ?? null),
  ])

  const messageUserIds = ticket.messages.map((m: any) => m.senderUserId)
  const activityActors = ticket.activities.map((a: any) => a.actorUserId).filter(Boolean) as string[]
  const allUserIds = Array.from(new Set<string>([
    ticket.createdByUserId,
    ...(ticket.assignedToUserId ? [ticket.assignedToUserId] : []),
    ...messageUserIds,
    ...activityActors,
  ]))
  const users = await SupportRepository.getUsersByIds(allUserIds)
  const userMap: Record<string, string> = {}
  for (const u of users) userMap[u.id] = u.name ?? u.email

  const visibleMessages = canSeeInternal ? ticket.messages : ticket.messages.filter((m: any) => !m.isInternal)

  const statusMap = Object.fromEntries(statusValues.map(s => [s.code, s.name]))
  const priorityMap = Object.fromEntries(priorityValues.map(p => [p.code, p.name]))

  const members = (await SupportRepository.searchPlatformStaff('')).map(u => ({
    userId: u.id, userName: u.name ?? u.email,
  }))

  // Fetch tenant metadata so the header/sidebar reflects the actual tenant
  // context. Internal tickets (tenantId null) legitimately fall back to
  // `null`, which the UI treats as the "Internal" context on purpose.
  const tenant = ticket.tenantId
    ? await db.tenant.findUnique({
        where: { id: ticket.tenantId },
        select: { id: true, name: true, planConfig: { select: { name: true } } },
      })
    : null

  const serialized = JSON.parse(JSON.stringify({
    ...ticket,
    messages: visibleMessages,
  }))

  return (
    <ConversationView
      ticketId={ticket.id}
      initialTicket={serialized}
      currentUserId={user.id}
      canManage={canManage}
      canSeeInternal={canSeeInternal}
      statusValues={statusValues}
      priorityValues={priorityValues}
      categoryValues={categoryValues}
      members={members}
      availableTags={availableTags}
      userMap={userMap}
      statusMap={statusMap}
      priorityMap={priorityMap}
      platformStaffIds={members.map(m => m.userId)}
      customerName={userMap[ticket.createdByUserId] ?? 'Unknown'}
      customerEmail={users.find(u => u.id === ticket.createdByUserId)?.email ?? null}
      tenantName={tenant?.name ?? null}
      tenantHref={tenant ? tenantPageHref(user, tenant.id, getDeploymentMode()) : null}
      tenantPlan={tenant?.planConfig.name ?? null}
    />
  )
}
