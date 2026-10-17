'use server'

import { revalidatePath } from 'next/cache'
import { safeAction } from '@/shared/lib/safe-action'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { revokeConnectionGrantSchema } from '../lib/grant.schema'
import { ConnectionGrantRepository } from '../lib/grant.repository'

/**
 * Revokes a grant on a connection of the session tenant, with an admin action; any other grant answers NotFound.
 * Studio drops the access when bridge.grants_v1 loses the row. A revoke reads nothing from Keycloak, so it
 * stays available while the session cannot read the directory: it can only narrow access.
 */
export const revokeConnectionGrant = safeAction(
  'revokeConnectionGrant',
  revokeConnectionGrantSchema,
  async ({ grantId }, user) => {
    await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No active tenant')

    const { connectionId } = await ConnectionGrantRepository.revoke(tenantId, grantId, user.id)
    revalidatePath(`/connections/${connectionId}`)
    return { id: grantId }
  },
)
