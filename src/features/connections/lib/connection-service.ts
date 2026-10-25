import type { AdminActionChannel } from '@prisma/client'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { getLicenseStatus } from '@/shared/lib/license/install-license'
import type { CurrentUser } from '@/shared/types'
import { DatabaseConnectionRepository } from './database-connection.repository'
import { grantableConnection, type GrantableConnection } from './grant-service'

// The connection operations of the bearer API (/api/v1), with the checks of the web console's updateDatabaseConnection.
// The caller names the channel of the admin action.

/**
 * Turns a connection of the user's tenant active or inactive; any other connection, or a deleted one, answers NotFound.
 * bridge.connections_v1 and bridge.grants_v1 publish only active connections, so turning one inactive withdraws it and
 * its grants from Studio without deleting either, and turning it active again publishes the same grants. In self-hosted
 * mode the license of the install may refuse a reactivation, which can take user seats.
 * The value the connection already has changes nothing and records no admin action, as the web console's change diff.
 * Returns the connection in the shape GET /api/v1/connections lists it.
 */
export async function setConnectionActive(
  connectionId: string,
  active: boolean,
  user: CurrentUser,
  channel: AdminActionChannel,
): Promise<GrantableConnection> {
  await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)
  const tenantId = user.currentTenantId
  if (!tenantId) throw new Error('No active tenant')

  const current = await DatabaseConnectionRepository.findById(tenantId, connectionId)
  if (current.active === active) return grantableConnection(current)
  const updated = await DatabaseConnectionRepository.update(
    tenantId,
    current.id,
    user.id,
    channel,
    { active },
    [],
    getLicenseStatus(),
  )
  return grantableConnection(updated)
}
