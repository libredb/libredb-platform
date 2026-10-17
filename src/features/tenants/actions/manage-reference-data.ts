'use server'

import { z } from 'zod'
import { safeAction } from '@/shared/lib/safe-action'
import { requireRole } from '@/shared/lib/auth-utils'
import { db } from '@/shared/lib/db'
import { revalidatePath } from 'next/cache'

const updateReferenceTypeSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required').optional(),
  description: z.string().optional(),
  category: z.string().optional(),
})

export const updateReferenceType = safeAction(
  'updateReferenceType',
  updateReferenceTypeSchema,
  async (data, user) => {
    await requireRole(user, 'PLATFORM_ADMIN')
    const { id, ...updateData } = data
    const result = await db.referenceType.update({
      where: { id },
      data: updateData,
    })
    revalidatePath('/admin/reference-data')
    return result
  },
)

const updateReferenceValueSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required').optional(),
  description: z.string().optional(),
  translations: z.string().optional(),
  colorCode: z.string().optional(),
  icon: z.string().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

export type UpdateReferenceValueData = z.infer<typeof updateReferenceValueSchema>

export const updateReferenceValue = safeAction(
  'updateReferenceValue',
  updateReferenceValueSchema,
  async (data, user) => {
    await requireRole(user, 'PLATFORM_ADMIN')

    const { id, translations, ...rest } = data
    const updateData: Record<string, unknown> = { ...rest }

    if (translations !== undefined) {
      try {
        updateData.translations = translations ? JSON.parse(translations) : null
      } catch {
        updateData.translations = null
      }
    }

    const result = await db.referenceValue.update({
      where: { id },
      data: updateData,
    })
    revalidatePath('/admin/reference-data')
    return result
  },
)

const createReferenceValueSchema = z.object({
  referenceTypeId: z.string(),
  code: z.string().min(1, 'Code is required'),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  translations: z.string().optional(),
  colorCode: z.string().optional(),
  icon: z.string().optional(),
})

export const createReferenceValue = safeAction(
  'createReferenceValue',
  createReferenceValueSchema,
  async (data, user) => {
    await requireRole(user, 'PLATFORM_ADMIN')

    const { translations, ...rest } = data
    const createData: Record<string, unknown> = { ...rest }

    if (translations) {
      try {
        createData.translations = JSON.parse(translations)
      } catch {
        createData.translations = null
      }
    }

    const maxOrder = await db.referenceValue.aggregate({
      where: { referenceTypeId: data.referenceTypeId },
      _max: { sortOrder: true },
    })
    createData.sortOrder = (maxOrder._max.sortOrder ?? 0) + 1

    const result = await db.referenceValue.create({
      data: createData as any,
    })
    revalidatePath('/admin/reference-data')
    return result
  },
)
