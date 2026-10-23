'use server'

import { revalidatePath } from 'next/cache'
import { safeAction } from '@/shared/lib/safe-action'
import { setConnectionGrantSchema } from '../lib/grant.schema'
import { setGrant } from '../lib/grant-service'

/** Grants a Keycloak user access to a connection, or changes their grant, as setGrant describes. */
export const setConnectionGrant = safeAction('setConnectionGrant', setConnectionGrantSchema, async (input, user) => {
  const grant = await setGrant(input, user, 'web')
  revalidatePath(`/connections/${input.connectionId}`)
  return grant
})
