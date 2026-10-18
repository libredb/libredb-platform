import { PERMISSIONS, SYSTEM_ROLES } from '@/shared/lib/permissions'
import type { DeploymentMode } from '@/shared/lib/deployment'
import type { CurrentUser } from '@/shared/types'

interface TicketRef {
  tenantId: string | null
  createdByUserId: string
  assignedToUserId: string | null
}

interface MessageRef {
  senderUserId: string
  createdAt: Date | string
  editedAt: Date | string | null
}

const EDIT_WINDOW_MS = 15 * 60 * 1000

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

export function canViewTicket(user: CurrentUser, ticket: TicketRef): boolean {
  if (user.permissions.includes(PERMISSIONS.TICKET_VIEW_ALL)) return true
  if (ticket.createdByUserId === user.id) return true
  if (ticket.assignedToUserId === user.id) return true
  if (
    user.permissions.includes(PERMISSIONS.TICKET_VIEW_TENANT) &&
    ticket.tenantId !== null &&
    ticket.tenantId === user.currentTenantId
  ) return true
  return false
}

export function canManageTicket(user: CurrentUser, ticket: TicketRef): boolean {
  if (!user.permissions.includes(PERMISSIONS.TICKET_MANAGE)) return false
  return canViewTicket(user, ticket)
}

export function canSeeInternalNotes(user: CurrentUser): boolean {
  return user.permissions.includes(PERMISSIONS.TICKET_VIEW_ALL)
}

export function canEditMessage(user: CurrentUser, message: MessageRef): boolean {
  if (message.senderUserId !== user.id) return false
  if (message.editedAt !== null) return false
  const age = Date.now() - toMs(message.createdAt)
  return age < EDIT_WINDOW_MS
}

export function canReopenTicket(user: CurrentUser, ticket: TicketRef): boolean {
  if (ticket.createdByUserId === user.id) return true
  return canManageTicket(user, ticket)
}

/**
 * The page of a ticket's tenant that the user can open, or null when there is none. The only page of a tenant is the
 * admin tenant page, /admin/tenants/<id>, which requires PLATFORM_ADMIN and answers 404 in self-hosted mode.
 */
export function tenantPageHref(
  user: Pick<CurrentUser, 'roles'>,
  tenantId: string,
  deploymentMode: DeploymentMode,
): string | null {
  if (deploymentMode === 'self-hosted' || !user.roles.includes(SYSTEM_ROLES.PLATFORM_ADMIN)) return null
  return `/admin/tenants/${tenantId}`
}
