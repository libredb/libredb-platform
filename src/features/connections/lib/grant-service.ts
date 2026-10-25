import type { AdminActionChannel } from '@prisma/client'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { ValidationError } from '@/shared/lib/errors'
import { readDirectory, requireDirectory } from '@/shared/lib/directory-guard'
import { getKeycloakDirectory } from '@/shared/lib/keycloak/directory'
import { getLicenseStatus } from '@/shared/lib/license/install-license'
import { getRuntimeConfig } from '@/shared/lib/runtime-config'
import type { CurrentUser } from '@/shared/types'
import { DatabaseConnectionRepository, type DatabaseConnectionView } from './database-connection.repository'
import { ConnectionGrantRepository } from './grant.repository'
import {
  DIRECTORY_PAGE_SIZE,
  studioRoleOf,
  type DirectoryUserPage,
  type GrantLevelValue,
  type RevokeConnectionGrantInput,
  type SearchDirectoryUsersInput,
  type SetConnectionGrantInput,
} from './grant.schema'

// The grant operations that the Server Actions of the web console and the routes of the bearer API (/api/v1) both
// call, so the checks and the admin actions cannot drift between them. The caller names the channel of the admin
// action; revalidatePath stays in the actions.

function tenantOf(user: CurrentUser): string {
  if (!user.currentTenantId) throw new Error('No active tenant')
  return user.currentTenantId
}

/** A connection as the bearer API lists it: no credential, kid or host. */
export interface GrantableConnection {
  id: string
  name: string
  engine: string
  status: 'active' | 'inactive'
  hasWriteCredential: boolean
}

/** A connection in the shape the bearer API answers it, by GET /api/v1/connections and PATCH /api/v1/connections/{id}. */
export function grantableConnection(connection: DatabaseConnectionView): GrantableConnection {
  return {
    id: connection.id,
    name: connection.name,
    engine: connection.engine,
    status: connection.active ? 'active' : 'inactive',
    hasWriteCredential: connection.hasWriteCredential,
  }
}

/** The connections of the user's tenant that a grant can name, newest first. */
export async function listGrantableConnections(user: CurrentUser): Promise<GrantableConnection[]> {
  await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)
  const connections = await DatabaseConnectionRepository.findAllByTenant(tenantOf(user))
  return connections.map(grantableConnection)
}

/** A grant as the bearer API lists it, with the Platform user who last set it at grantedAt. */
export interface GrantSummary {
  id: string
  subject: string
  subjectUsername: string
  subjectEmail: string | null
  level: GrantLevelValue
  expiresAt: Date | null
  grantedBy: { id: string; name: string | null; email: string }
  grantedAt: Date
}

/** The grants of a connection of the user's tenant, by username; any other connection answers NotFound. */
export async function listConnectionGrants(connectionId: string, user: CurrentUser): Promise<GrantSummary[]> {
  await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)
  const tenantId = tenantOf(user)
  const connection = await DatabaseConnectionRepository.findById(tenantId, connectionId)
  const grants = await ConnectionGrantRepository.listForConnection(tenantId, connection.id)
  return grants.map((grant) => ({
    id: grant.id,
    subject: grant.subject,
    subjectUsername: grant.subjectUsername,
    subjectEmail: grant.subjectEmail,
    level: grant.level,
    expiresAt: grant.expiresAt,
    grantedBy: { id: grant.grantedById, name: grant.grantedBy.name, email: grant.grantedBy.email },
    grantedAt: grant.grantedAt,
  }))
}

/**
 * Grants a Keycloak user read or write access to a connection of the user's tenant, or changes the grant that user
 * already has; any other connection answers NotFound. Write needs the connection's write credential.
 * The subject must be an enabled user of the Keycloak directory, whose username and email the grant keeps for display,
 * so the grant is refused while the session cannot read the directory, and a Keycloak that does not answer throws
 * DirectoryUnavailableError. An expiry must lie in the future.
 * In self-hosted mode a user who holds no user seat is granted an active connection only when the license of the
 * install allows another seat, while a grant on a paused connection takes none until the connection is active again;
 * Keycloak answers before the grant's transaction begins, so no HTTP call runs while its seat gate holds the lock.
 * Returns the grant id only.
 */
export async function setGrant(
  { connectionId, subject, level, expiresAt }: SetConnectionGrantInput,
  user: CurrentUser,
  channel: AdminActionChannel,
): Promise<{ id: string }> {
  await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)
  const tenantId = tenantOf(user)

  const connection = await DatabaseConnectionRepository.findById(tenantId, connectionId)
  if (level === 'write' && !connection.hasWriteCredential) {
    throw new ValidationError({ level: ['The connection has no write credential, so it can be granted read only'] })
  }

  requireDirectory(user)
  const directoryUser = await readDirectory(() => getKeycloakDirectory().getUser(subject))
  if (directoryUser === null) {
    throw new ValidationError({ subject: ['Keycloak has no user with this id'] })
  }
  if (!directoryUser.enabled) {
    throw new ValidationError({ subject: [`${directoryUser.username} is disabled in Keycloak`] })
  }

  const now = new Date()
  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    throw new ValidationError({ expiresAt: ['must be in the future'] })
  }

  return ConnectionGrantRepository.set(
    tenantId,
    user.id,
    channel,
    {
      connectionId: connection.id,
      // The id as Keycloak reports it, which is the sub of the user's tokens that Studio matches grants with.
      subject: directoryUser.id,
      subjectUsername: directoryUser.username,
      subjectEmail: directoryUser.email,
      level,
      expiresAt,
    },
    now,
    getLicenseStatus(now),
  )
}

/**
 * Revokes a grant on a connection of the user's tenant, with an admin action; any other grant answers NotFound, and so
 * does a grant of another connection when `connectionId` is given. Studio drops the access when bridge.grants_v1 loses
 * the row. A revoke reads nothing from Keycloak, so it stays available while the session cannot read the directory: it
 * can only narrow access. Returns the connection of the grant.
 */
export async function revokeGrant(
  { grantId, connectionId }: RevokeConnectionGrantInput & { connectionId?: string },
  user: CurrentUser,
  channel: AdminActionChannel,
): Promise<{ connectionId: string }> {
  await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)
  return ConnectionGrantRepository.revoke(tenantOf(user), grantId, user.id, channel, connectionId)
}

/**
 * One page of the Keycloak users the grant picker offers, 20 per page, each with the badge of the Studio role their
 * effective roles give. Keycloak 26.8.1 matches a search against the start of the username, first name,
 * last name or email, so the typed text is wrapped in `*` to match anywhere in them. Disabled users are listed with
 * `enabled` false, because a grant to one is refused. Refused while the session cannot read the directory, and a
 * Keycloak that does not answer throws DirectoryUnavailableError.
 * Where the license of a self-hosted install applies, each user who holds no user seat is marked, because a grant to
 * them takes one while its connection is active.
 */
export async function searchDirectory(
  { search, page }: SearchDirectoryUsersInput,
  user: CurrentUser,
): Promise<DirectoryUserPage> {
  await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)
  requireDirectory(user)

  const directory = getKeycloakDirectory()
  const { PLATFORM_ADMIN_ROLE, STUDIO_USER_ROLE } = getRuntimeConfig()
  const pattern = search === '' ? undefined : `*${search}*`
  const [found, total] = await readDirectory(() =>
    Promise.all([
      directory.searchUsers({ search: pattern, first: (page - 1) * DIRECTORY_PAGE_SIZE, max: DIRECTORY_PAGE_SIZE }),
      directory.countUsers(pattern),
    ]),
  )
  const [roles, seatHolders] = await Promise.all([
    readDirectory(() => Promise.all(found.map((match) => directory.getEffectiveRoles(match.id)))),
    getLicenseStatus() === null ? null : ConnectionGrantRepository.userSeatHolders(found.map((match) => match.id)),
  ])
  const users = found.map((match, index) => ({
    ...match,
    studioRole: studioRoleOf(roles[index], PLATFORM_ADMIN_ROLE, STUDIO_USER_ROLE),
    needsSeat: seatHolders !== null && !seatHolders.has(match.id),
  }))
  return { users, page, total }
}
