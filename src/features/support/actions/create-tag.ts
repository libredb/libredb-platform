'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { createTagSchema } from '../lib/support.schema'
import { db } from '@/shared/lib/db'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'

export const createTag = safeAction(
  'createTag',
  createTagSchema,
  async (data, user) => {
    await requirePermission(user, PERMISSIONS.TAG_CREATE)
    return db.supportTag.create({
      data: {
        tenantId: data.tenantId ?? null,
        name: data.name,
        colorCode: data.colorCode ?? null,
        description: data.description ?? null,
        createdByUserId: user.id,
      },
    })
  },
)
