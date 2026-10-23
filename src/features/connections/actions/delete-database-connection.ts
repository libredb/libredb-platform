'use server'

import { revalidatePath } from 'next/cache'
import { safeAction } from '@/shared/lib/safe-action'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { deleteDatabaseConnectionSchema } from '../lib/database-connection.schema'
import { DatabaseConnectionRepository } from '../lib/database-connection.repository'

/**
 * Deletes a connection of the session tenant softly, with an admin action: Studio stops serving it as soon as
 * bridge.connections_v1 drops the row, and its query events keep the connection they name. Its grants are deleted in
 * the same transaction, each with an admin action of its own. Any other id answers NotFound.
 */
export const deleteDatabaseConnection = safeAction(
  'deleteDatabaseConnection',
  deleteDatabaseConnectionSchema,
  async ({ id }, user) => {
    await requirePermission(user, PERMISSIONS.CONNECTION_DELETE)

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No active tenant')

    await DatabaseConnectionRepository.softDelete(tenantId, id, user.id, 'web')
    revalidatePath('/connections')
    return { id }
  },
)
