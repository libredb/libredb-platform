'use server'

import { z } from 'zod'
import { safeAction } from '@/shared/lib/safe-action'
import { assertCloudOnly } from '@/shared/lib/deployment'
import { requireRole } from '@/shared/lib/auth-utils'
import { db } from '@/shared/lib/db'
import { revalidatePath } from 'next/cache'

const updatePlanSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required').optional(),
  description: z.string().optional(),
  maxUsers: z.number().int().min(1).optional(),
  maxConnections: z.number().int().min(1).optional(),
  queryHistoryDays: z.number().int().min(1).optional(),
  featureSharedQueries: z.boolean().optional(),
  featureAdvancedRbac: z.boolean().optional(),
  featureAuditLog: z.boolean().optional(),
  featurePerfTracking: z.boolean().optional(),
  featureDataMasking: z.boolean().optional(),
  featureSamlSso: z.boolean().optional(),
  featureScimProvisioning: z.boolean().optional(),
  featureSelfHosted: z.boolean().optional(),
  featureApiAccess: z.boolean().optional(),
  pricePerUserMonthly: z.string().optional(),
})

export type UpdatePlanData = z.infer<typeof updatePlanSchema>

export const updatePlan = safeAction(
  'updatePlan',
  updatePlanSchema,
  async (data, user) => {
    assertCloudOnly()
    await requireRole(user, 'PLATFORM_ADMIN')

    const { id, pricePerUserMonthly, ...rest } = data

    const updateData: Record<string, unknown> = { ...rest }
    if (pricePerUserMonthly !== undefined) {
      updateData.pricePerUserMonthly =
        pricePerUserMonthly === '' ? null : parseFloat(pricePerUserMonthly)
    }

    const plan = await db.planConfig.update({
      where: { id },
      data: updateData,
    })

    revalidatePath('/admin/plans')
    return plan
  },
)
