import { z } from 'zod'

export const createTenantSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  slug: z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .regex(
      /^[a-z0-9-]+$/,
      'Slug must be lowercase letters, numbers, and hyphens only',
    ),
  planConfigId: z.string().min(1, 'Plan is required'),
})

export const updateTenantSchema = z.object({
  id: z.string(),
  name: z.string().min(2, 'Name must be at least 2 characters').optional(),
  slug: z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .regex(
      /^[a-z0-9-]+$/,
      'Slug must be lowercase letters, numbers, and hyphens only',
    )
    .optional(),
  planConfigId: z.string().optional(),
  active: z.boolean().optional(),
})

export type CreateTenantData = z.infer<typeof createTenantSchema>
export type UpdateTenantData = z.infer<typeof updateTenantSchema>
