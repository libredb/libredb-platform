'use server'

import { revalidatePath } from 'next/cache'
import { safeAction } from '@/shared/lib/safe-action'
import { revokeConnectionGrantSchema } from '../lib/grant.schema'
import { revokeGrant } from '../lib/grant-service'

/** Revokes a grant on a connection, as revokeGrant describes. */
export const revokeConnectionGrant = safeAction(
  'revokeConnectionGrant',
  revokeConnectionGrantSchema,
  async ({ grantId }, user) => {
    const { connectionId } = await revokeGrant({ grantId }, user, 'web')
    revalidatePath(`/connections/${connectionId}`)
    return { id: grantId }
  },
)
