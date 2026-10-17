'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { assertCloudOnly } from '@/shared/lib/deployment'
import { requirePermission } from '@/shared/lib/auth-utils'
import { updateUserRoleSchema, toggleUserActiveSchema } from '../lib/user.schema'
import { UserRepository } from '../lib/user.repository'
import { revalidatePath } from 'next/cache'

export const updateUserRole = safeAction(
  'updateUserRole',
  updateUserRoleSchema,
  async (data, user) => {
    assertCloudOnly()
    await requirePermission(user, 'user.edit')

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No tenant selected')

    await UserRepository.requireAssignableRole(tenantId, data.roleId)
    await UserRepository.updateMemberRole(tenantId, data.membershipId, data.roleId)
    revalidatePath('/team')
    return { success: true }
  },
)

export const toggleUserActive = safeAction(
  'toggleUserActive',
  toggleUserActiveSchema,
  async (data, user) => {
    assertCloudOnly()
    await requirePermission(user, 'user.edit')

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No tenant selected')

    await UserRepository.toggleMemberActive(tenantId, data.membershipId, data.active)
    revalidatePath('/team')
    return { success: true }
  },
)
