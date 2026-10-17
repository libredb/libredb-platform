export const PERMISSIONS = {
  QUERY_EXECUTE: 'query.execute',
  QUERY_WRITE: 'query.write',
  SCHEMA_VIEW: 'schema.view',
  AI_USE: 'ai.use',
  CONNECTION_CREATE: 'connection.create',
  CONNECTION_EDIT: 'connection.edit',
  CONNECTION_DELETE: 'connection.delete',
  CONNECTION_VIEW: 'connection.view',
  USER_INVITE: 'user.invite',
  USER_EDIT: 'user.edit',
  USER_DELETE: 'user.delete',
  USER_VIEW: 'user.view',
  AUDIT_VIEW: 'audit.view',
  AUDIT_EXPORT: 'audit.export',
  BILLING_VIEW: 'billing.view',
  BILLING_MANAGE: 'billing.manage',
  TICKET_CREATE: 'ticket.create',
  TICKET_VIEW: 'ticket.view',
  TICKET_VIEW_TENANT: 'ticket.view.tenant',
  TICKET_VIEW_ALL: 'ticket.view.all',
  TICKET_MANAGE: 'ticket.manage',
  TICKET_DELETE: 'ticket.delete',
  TAG_CREATE: 'tag.create',
  TAG_MANAGE: 'tag.manage',
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_EDIT: 'settings.edit',
  LOV_MANAGE: 'lov.manage',
  TENANT_MANAGE: 'tenant.manage',
  PLATFORM_DASHBOARD: 'platform.dashboard',
} as const

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

export const SYSTEM_ROLES = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  PLATFORM_TECH: 'PLATFORM_TECH',
  PLATFORM_SUPPORT: 'PLATFORM_SUPPORT',
  TENANT_ADMIN: 'TENANT_ADMIN',
  TENANT_EDITOR: 'TENANT_EDITOR',
  TENANT_VIEWER: 'TENANT_VIEWER',
} as const

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  PLATFORM_ADMIN: Object.values(PERMISSIONS),
  PLATFORM_SUPPORT: [
    PERMISSIONS.PLATFORM_DASHBOARD,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.TICKET_CREATE,
    PERMISSIONS.TICKET_VIEW,
    PERMISSIONS.TICKET_VIEW_ALL,
    PERMISSIONS.TICKET_MANAGE,
    PERMISSIONS.TAG_CREATE,
    PERMISSIONS.TAG_MANAGE,
    PERMISSIONS.USER_VIEW,
  ],
  PLATFORM_TECH: [
    PERMISSIONS.PLATFORM_DASHBOARD,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.TICKET_CREATE,
    PERMISSIONS.TICKET_VIEW,
    PERMISSIONS.TICKET_VIEW_ALL,
  ],
  TENANT_ADMIN: [
    PERMISSIONS.QUERY_EXECUTE, PERMISSIONS.QUERY_WRITE, PERMISSIONS.SCHEMA_VIEW, PERMISSIONS.AI_USE,
    PERMISSIONS.CONNECTION_CREATE, PERMISSIONS.CONNECTION_EDIT, PERMISSIONS.CONNECTION_DELETE, PERMISSIONS.CONNECTION_VIEW,
    PERMISSIONS.USER_INVITE, PERMISSIONS.USER_EDIT, PERMISSIONS.USER_DELETE, PERMISSIONS.USER_VIEW,
    PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_EXPORT,
    PERMISSIONS.BILLING_VIEW, PERMISSIONS.BILLING_MANAGE,
    PERMISSIONS.TICKET_CREATE, PERMISSIONS.TICKET_VIEW, PERMISSIONS.TICKET_VIEW_TENANT,
    PERMISSIONS.SETTINGS_VIEW, PERMISSIONS.SETTINGS_EDIT, PERMISSIONS.LOV_MANAGE,
  ],
  // connection.view lists and opens every connection of the tenant, so it stays with the roles that manage connections.
  // Access to a connection's data comes from grants in Studio.
  TENANT_EDITOR: [
    PERMISSIONS.QUERY_EXECUTE, PERMISSIONS.QUERY_WRITE, PERMISSIONS.SCHEMA_VIEW, PERMISSIONS.AI_USE,
    PERMISSIONS.TICKET_CREATE, PERMISSIONS.TICKET_VIEW,
  ],
  TENANT_VIEWER: [
    PERMISSIONS.QUERY_EXECUTE, PERMISSIONS.SCHEMA_VIEW,
    PERMISSIONS.TICKET_CREATE, PERMISSIONS.TICKET_VIEW,
  ],
}

// Codes only the seeded system roles may carry. Every code that starts with
// RESERVED_ROLE_CODE_PREFIX is reserved as well; isReservedRoleCode applies both.
export const RESERVED_ROLE_CODES: readonly string[] = Object.values(SYSTEM_ROLES)
export const RESERVED_ROLE_CODE_PREFIX = 'PLATFORM_'

export function isReservedRoleCode(code: string): boolean {
  return RESERVED_ROLE_CODES.includes(code) || code.startsWith(RESERVED_ROLE_CODE_PREFIX)
}

export const TENANT_ASSIGNABLE_SYSTEM_ROLES: readonly string[] = [
  SYSTEM_ROLES.TENANT_ADMIN,
  SYSTEM_ROLES.TENANT_EDITOR,
  SYSTEM_ROLES.TENANT_VIEWER,
]

export const TENANT_ASSIGNABLE_PERMISSIONS: readonly string[] = ROLE_PERMISSIONS.TENANT_ADMIN

// A tenant may assign the TENANT_ system roles and its own custom roles; a
// custom role with a reserved code, left by the escalation this rule closes,
// is never assignable.
export function isTenantAssignableRole(
  role: { code: string; isSystem: boolean; tenantId: string | null },
  tenantId: string,
): boolean {
  if (role.isSystem) return TENANT_ASSIGNABLE_SYSTEM_ROLES.includes(role.code)
  return role.tenantId === tenantId && !isReservedRoleCode(role.code)
}

// The role codes a session carries: a reserved code counts only on a system role.
export function sessionRoleCodes(userRoles: readonly { role: { code: string; isSystem: boolean } }[]): string[] {
  return userRoles
    .filter(({ role }) => role.isSystem || !isReservedRoleCode(role.code))
    .map(({ role }) => role.code)
}
