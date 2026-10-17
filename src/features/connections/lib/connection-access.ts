import { getKeycloakDirectory, type KeycloakDirectory } from '@/shared/lib/keycloak/directory'
import { KeycloakNotFoundError, KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'
import { getRuntimeConfig } from '@/shared/lib/runtime-config'
import { logger } from '@/shared/lib/logger'
import type { CurrentUser } from '@/shared/types'
import { ConnectionGrantRepository, type GrantWithGranter } from './grant.repository'
import {
  studioRoleOf,
  type ConnectionAccess,
  type ConnectionAccessGrant,
  type GrantSubjectStatus,
} from './grant.schema'

/** The reads of the Keycloak directory behind the access panel, and the role names of the badges. */
export interface ConnectionAccessDeps {
  directory: Pick<KeycloakDirectory, 'getUser' | 'getEffectiveRoles'>
  roles: { adminRole: string; userRole: string }
}

type SessionUser = Pick<CurrentUser, 'id' | 'directoryDegraded'>

function processDeps(): ConnectionAccessDeps {
  const config = getRuntimeConfig()
  return {
    directory: getKeycloakDirectory(),
    roles: { adminRole: config.PLATFORM_ADMIN_ROLE, userRole: config.STUDIO_USER_ROLE },
  }
}

/** What Keycloak says of the subject now; a user deleted between the two reads counts as missing. */
async function subjectStatus(subject: string, deps: ConnectionAccessDeps): Promise<GrantSubjectStatus> {
  const found = await deps.directory.getUser(subject)
  if (found === null) return { status: 'missing' }
  try {
    const roles = await deps.directory.getEffectiveRoles(subject)
    return {
      status: 'present',
      studioRole: studioRoleOf(roles, deps.roles.adminRole, deps.roles.userRole),
      enabled: found.enabled,
    }
  } catch (error) {
    if (error instanceof KeycloakNotFoundError) return { status: 'missing' }
    throw error
  }
}

function toPanelGrant(grant: GrantWithGranter, hasWriteCredential: boolean, directory: GrantSubjectStatus): ConnectionAccessGrant {
  return {
    id: grant.id,
    subject: grant.subject,
    username: grant.subjectUsername,
    email: grant.subjectEmail,
    level: grant.level,
    downgraded: grant.level === 'write' && !hasWriteCredential,
    expiresAt: grant.expiresAt === null ? null : grant.expiresAt.toISOString(),
    grantedBy: grant.grantedBy.name ?? grant.grantedBy.email,
    grantedAt: grant.grantedAt.toISOString(),
    directory,
  }
}

/**
 * The grants with the live directory status of each subject. A degraded session reads nothing from
 * Keycloak, and a Keycloak that does not answer is reported as unreachable, not thrown, so the panel still
 * lists and revokes grants. Every other failure, such as a service account that Keycloak refuses, is thrown.
 */
export async function toConnectionAccess(
  grants: GrantWithGranter[],
  hasWriteCredential: boolean,
  user: SessionUser,
  deps?: ConnectionAccessDeps,
): Promise<ConnectionAccess> {
  const unknown = (): ConnectionAccess => ({
    directory: user.directoryDegraded ? 'degraded' : 'unreachable',
    grants: grants.map((grant) => toPanelGrant(grant, hasWriteCredential, { status: 'unknown' })),
  })
  if (user.directoryDegraded) return unknown()

  const resolved = deps ?? processDeps()
  try {
    const statuses = await Promise.all(grants.map((grant) => subjectStatus(grant.subject, resolved)))
    return {
      directory: 'available',
      grants: grants.map((grant, index) => toPanelGrant(grant, hasWriteCredential, statuses[index])),
    }
  } catch (error) {
    if (!(error instanceof KeycloakUnavailableError)) throw error
    logger.warn('Connection access: the Keycloak directory is unreachable', { userId: user.id, error: error.message })
    return unknown()
  }
}

/** The access panel of a connection of the session tenant, which the caller has found. */
export async function loadConnectionAccess(
  user: SessionUser,
  tenantId: string,
  connection: { id: string; hasWriteCredential: boolean },
  deps?: ConnectionAccessDeps,
): Promise<ConnectionAccess> {
  const grants = await ConnectionGrantRepository.listForConnection(tenantId, connection.id)
  return toConnectionAccess(grants, connection.hasWriteCredential, user, deps)
}
