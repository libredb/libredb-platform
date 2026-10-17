'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { safeAction } from '@/shared/lib/safe-action'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { StudioSettingsRepository } from '../lib/studio-settings.repository'
import { assertStudioSettingsAvailable, requireAllowlistedKey } from '../lib/require-allowlisted-key'

const resetStudioSettingSchema = z.object({
  key: z.string().min(1),
})

export const resetStudioSetting = safeAction(
  'resetStudioSetting',
  resetStudioSettingSchema,
  async ({ key }, user) => {
    assertStudioSettingsAvailable()
    await requirePermission(user, PERMISSIONS.SETTINGS_EDIT)

    await requireAllowlistedKey(key)
    await StudioSettingsRepository.reset(key, user.id)
    revalidatePath('/studio-settings')
    return { key }
  },
)
