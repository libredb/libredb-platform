import type { PrismaClient } from '@prisma/client'
import { sessionRoleCodes, TENANT_ASSIGNABLE_PERMISSIONS } from '../permissions'

/** A Credentials session re-reads its user and membership once its last read is older than this. */
export const CREDENTIALS_RECHECK_SECONDS = 60

/** A role of a membership, with the codes of its permissions, as Prisma reads it through user_roles. */
export interface MembershipRole {
  role: {
    code: string
    isSystem: boolean
    permissions: readonly { permission: { code: string } }[]
  }
}

/**
 * The roles and permissions that a membership gives a Credentials session.
 * A role counts only when sessionRoleCodes admits it, so a custom role that took a reserved code before custom roles
 * were refused such codes grants nothing, and a custom role contributes only the permissions that TENANT_ADMIN holds.
 */
export function membershipAccess(userRoles: readonly MembershipRole[]): { roles: string[]; permissions: string[] } {
  const admitted = userRoles.filter(userRole => sessionRoleCodes([userRole]).length > 0)
  const permissions = admitted.flatMap(({ role }) =>
    role.permissions
      .map(({ permission }) => permission.code)
      .filter(code => role.isSystem || TENANT_ASSIGNABLE_PERMISSIONS.includes(code)),
  )
  return { roles: sessionRoleCodes(userRoles), permissions: [...new Set(permissions)] }
}

/** The access of a Credentials session in its current tenant. */
export interface CredentialsAccess {
  membershipId: string | null
  roles: string[]
  permissions: string[]
}

/** The Prisma delegates that the session re-read uses, injected so that it runs without the shared client. */
export type CredentialsSessionClient = Pick<PrismaClient, 'user' | 'tenantMember'>

/**
 * Reads the access of a Credentials session in a tenant, or in no tenant for a user without one.
 * Answers null when the user is missing or inactive, or when the user has no active membership of the tenant.
 */
export async function loadCredentialsAccess(
  client: CredentialsSessionClient,
  userId: string,
  tenantId: string | null,
): Promise<CredentialsAccess | null> {
  const user = await client.user.findUnique({ where: { id: userId }, select: { active: true } })
  if (!user?.active) return null
  if (tenantId === null) return { membershipId: null, roles: [], permissions: [] }

  const membership = await client.tenantMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: {
      id: true,
      active: true,
      roles: {
        select: {
          role: {
            select: { code: true, isSystem: true, permissions: { select: { permission: { select: { code: true } } } } },
          },
        },
      },
    },
  })
  if (!membership?.active) return null
  return { membershipId: membership.id, ...membershipAccess(membership.roles) }
}

/** The fields of a Credentials session token that the re-read reads and writes. */
export interface CredentialsToken {
  id: string
  /** When the access was last read, in seconds since the epoch. */
  checkedAt: number
  currentTenantId: string | null
  membershipId: string | null
  roles: string[]
  permissions: string[]
}

export interface CredentialsRefresh {
  /** Now, in seconds since the epoch. */
  now: number
  /** The tenant that the libredb-current-tenant cookie asks for, which only cloud mode reads. */
  requestedTenantId?: string
  loadAccess(userId: string, tenantId: string | null): Promise<CredentialsAccess | null>
}

/**
 * Keeps a Credentials session token current.
 * A requested tenant that the user is an active member of becomes the session's tenant at once, and any other is ignored.
 * Once the last read is older than 60 seconds, the user and the membership of the current tenant are read again:
 * changed roles and permissions apply from this request, and an inactive user or membership ends the session (null).
 */
export async function refreshCredentialsToken<T extends CredentialsToken>(token: T, refresh: CredentialsRefresh): Promise<T | null> {
  const { now, requestedTenantId, loadAccess } = refresh

  if (requestedTenantId !== undefined && requestedTenantId !== token.currentTenantId) {
    const requested = await loadAccess(token.id, requestedTenantId)
    if (requested) return { ...token, ...requested, currentTenantId: requestedTenantId, checkedAt: now }
  }

  if (now - token.checkedAt <= CREDENTIALS_RECHECK_SECONDS) return token

  const access = await loadAccess(token.id, token.currentTenantId)
  if (!access) return null
  return { ...token, ...access, checkedAt: now }
}
