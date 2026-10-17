'use server'

import { z } from 'zod'
import { safeAction } from '@/shared/lib/safe-action'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { db } from '@/shared/lib/db'
import { NotFoundError } from '@/shared/lib/errors'
import { revalidatePath } from 'next/cache'

const updateSettingsSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  logoUrl: z.string().url('Must be a valid URL').or(z.literal('')).optional(),
})

export type UpdateSettingsData = z.infer<typeof updateSettingsSchema>

export const updateSettings = safeAction(
  'updateSettings',
  updateSettingsSchema,
  async (data, user) => {
    await requirePermission(user, PERMISSIONS.SETTINGS_EDIT)

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No active tenant')

    const tenant = await db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundError('Tenant')

    const updated = await db.tenant.update({
      where: { id: tenantId },
      data: {
        name: data.name,
        logoUrl: data.logoUrl || null,
      },
    })

    revalidatePath('/settings')
    return updated
  },
)
