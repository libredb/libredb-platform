'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { safeAction } from '@/shared/lib/safe-action'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { ValidationError } from '@/shared/lib/errors'
import { StudioSettingsRepository } from '../lib/studio-settings.repository'
import { assertStudioSettingsAvailable, requireAllowlistedKey } from '../lib/require-allowlisted-key'
import { HELD_STUDIO_SETTING_NOTE, isHeldStudioSettingKey, studioSettingValueError } from '../lib/setting-value'

const updateStudioSettingSchema = z.object({
  key: z.string().min(1),
  // The type, range and allowed set come from the key's allowlist row, checked in the handler.
  value: z.union([z.boolean(), z.number(), z.string()]),
})

export type UpdateStudioSettingData = z.infer<typeof updateStudioSettingSchema>

export const updateStudioSetting = safeAction(
  'updateStudioSetting',
  updateStudioSettingSchema,
  async ({ key, value }, user) => {
    assertStudioSettingsAvailable()
    await requirePermission(user, PERMISSIONS.SETTINGS_EDIT)

    const row = await requireAllowlistedKey(key)
    if (isHeldStudioSettingKey(key)) {
      throw new ValidationError({ key: [`${key} is ${HELD_STUDIO_SETTING_NOTE}`] })
    }
    const error = studioSettingValueError(row, value)
    if (error) throw new ValidationError({ value: [error] })

    await StudioSettingsRepository.set(key, value, user.id, 'web')
    revalidatePath('/studio-settings')
    return { key }
  },
)
