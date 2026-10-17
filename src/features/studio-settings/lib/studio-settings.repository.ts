import { db } from '@/shared/lib/db'
import { recordAdminAction } from '@/shared/lib/admin-actions'
import { toStudioSettingField, type StudioSettingField, type StudioSettingValue } from './setting-value'

// The target type of the admin actions that record a Studio setting change.
const TARGET_TYPE = 'studio_setting'

export const StudioSettingsRepository = {
  /** Every allowlisted key with its current value, in key order. */
  async listFields(): Promise<StudioSettingField[]> {
    const rows = await db.studioSettingKey.findMany({
      include: { settings: { select: { value: true, updatedAt: true } } },
      orderBy: { key: 'asc' },
    })
    return rows.map(({ settings, ...row }) => toStudioSettingField(row, settings[0] ?? null))
  },

  findKey(key: string) {
    return db.studioSettingKey.findUnique({ where: { key } })
  },

  /** Writes the value and its admin action in one transaction; the validation trigger rechecks the value. */
  set(key: string, value: StudioSettingValue, actorId: string) {
    return db.$transaction(async (tx) => {
      const before = await tx.studioSetting.findUnique({ where: { key } })
      await tx.studioSetting.upsert({
        where: { key },
        create: { key, value, updatedBy: actorId },
        update: { value, updatedBy: actorId },
      })
      await recordAdminAction(tx, {
        actorId,
        action: 'settings.update',
        targetType: TARGET_TYPE,
        targetId: key,
        before: before ? { value: before.value as StudioSettingValue } : null,
        after: { value },
      })
    })
  },

  /** Deletes the value so Studio applies its default, with an admin action when a value existed. */
  reset(key: string, actorId: string) {
    return db.$transaction(async (tx) => {
      const before = await tx.studioSetting.findUnique({ where: { key } })
      if (!before) return
      await tx.studioSetting.deleteMany({ where: { key } })
      await recordAdminAction(tx, {
        actorId,
        action: 'settings.reset',
        targetType: TARGET_TYPE,
        targetId: key,
        before: { value: before.value as StudioSettingValue },
        after: null,
      })
    })
  },
}
