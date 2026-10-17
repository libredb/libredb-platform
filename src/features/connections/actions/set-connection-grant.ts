'use server'

import { revalidatePath } from 'next/cache'
import { safeAction } from '@/shared/lib/safe-action'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { ValidationError } from '@/shared/lib/errors'
import { requireDirectory } from '@/shared/lib/directory-guard'
import { getKeycloakDirectory } from '@/shared/lib/keycloak/directory'
import { getLicenseStatus } from '@/shared/lib/license/install-license'
import { setConnectionGrantSchema } from '../lib/grant.schema'
import { DatabaseConnectionRepository } from '../lib/database-connection.repository'
import { ConnectionGrantRepository } from '../lib/grant.repository'

/**
 * Grants a Keycloak user read or write access to a connection of the session tenant, or changes the grant that user
 * already has; any other connection answers NotFound. Write needs the connection's write credential.
 * The subject must be an enabled user of the Keycloak directory, whose username and email the grant keeps for display,
 * so the action is refused while the session cannot read the directory. An expiry must lie in the future.
 * In self-hosted mode a user who holds no user seat is granted an active connection only when the license of the
 * install allows another seat, while a grant on a paused connection takes none until the connection is active again;
 * Keycloak answers before the grant's transaction begins, so no HTTP call runs while its seat gate holds the lock.
 * Returns the grant id only.
 */
export const setConnectionGrant = safeAction(
  'setConnectionGrant',
  setConnectionGrantSchema,
  async ({ connectionId, subject, level, expiresAt }, user) => {
    await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No active tenant')

    const connection = await DatabaseConnectionRepository.findById(tenantId, connectionId)
    if (level === 'write' && !connection.hasWriteCredential) {
      throw new ValidationError({ level: ['The connection has no write credential, so it can be granted read only'] })
    }

    requireDirectory(user)
    const directoryUser = await getKeycloakDirectory().getUser(subject)
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

    const grant = await ConnectionGrantRepository.set(
      tenantId,
      user.id,
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

    revalidatePath(`/connections/${connection.id}`)
    return { id: grant.id }
  },
)
