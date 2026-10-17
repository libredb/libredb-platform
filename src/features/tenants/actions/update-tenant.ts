'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { assertCloudOnly } from '@/shared/lib/deployment'
import { updateTenantSchema } from '../lib/tenant.schema'
import { TenantRepository } from '../lib/tenant.repository'
import { requireRole } from '@/shared/lib/auth-utils'
import { revalidatePath } from 'next/cache'

export const updateTenant = safeAction(
  'updateTenant',
  updateTenantSchema,
  async (data, user) => {
    assertCloudOnly()
    await requireRole(user, 'PLATFORM_ADMIN')
    const { id, ...updateData } = data
    const tenant = await TenantRepository.update(id, updateData)
    revalidatePath('/admin/tenants')
    revalidatePath(`/admin/tenants/${id}`)
    return tenant
  },
)
