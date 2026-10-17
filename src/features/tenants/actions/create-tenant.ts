'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { assertCloudOnly } from '@/shared/lib/deployment'
import { createTenantSchema } from '../lib/tenant.schema'
import { TenantRepository } from '../lib/tenant.repository'
import { requireRole } from '@/shared/lib/auth-utils'
import { revalidatePath } from 'next/cache'

export const createTenant = safeAction(
  'createTenant',
  createTenantSchema,
  async (data, user) => {
    assertCloudOnly()
    await requireRole(user, 'PLATFORM_ADMIN')
    const tenant = await TenantRepository.create(data)
    revalidatePath('/admin/tenants')
    return tenant
  },
)
