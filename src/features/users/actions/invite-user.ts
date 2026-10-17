'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { assertCloudOnly } from '@/shared/lib/deployment'
import { requirePermission } from '@/shared/lib/auth-utils'
import { checkLimit } from '@/shared/lib/feature-flags'
import { LimitExceededError } from '@/shared/lib/errors'
import { inviteUserSchema } from '../lib/user.schema'
import { UserRepository } from '../lib/user.repository'
import { revalidatePath } from 'next/cache'

export const inviteUser = safeAction(
  'inviteUser',
  inviteUserSchema,
  async (data, user) => {
    assertCloudOnly()
    await requirePermission(user, 'user.invite')

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No tenant selected')

    await UserRepository.requireAssignableRole(tenantId, data.roleId)

    // Check user limit
    const currentCount = await UserRepository.countActiveMembers(tenantId)
    const withinLimit = await checkLimit(tenantId, 'maxUsers', currentCount)
    if (!withinLimit) {
      throw new LimitExceededError('users', currentCount)
    }

    const invitation = await UserRepository.createInvitation(
      tenantId,
      data.email,
      data.roleId,
    )

    revalidatePath('/team')
    revalidatePath('/team/invitations')
    return invitation
  },
)
