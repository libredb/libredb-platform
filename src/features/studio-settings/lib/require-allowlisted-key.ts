import { isSelfHosted } from '@/shared/lib/deployment'
import { ForbiddenError, ValidationError } from '@/shared/lib/errors'
import { StudioSettingsRepository } from './studio-settings.repository'
import type { StudioSettingKeyRow } from './setting-value'

/** Studio reads its settings only from a self-hosted install, so cloud mode has nothing to change. */
export function assertStudioSettingsAvailable(): void {
  if (!isSelfHosted()) {
    throw new ForbiddenError('not available in cloud mode')
  }
}

/** The allowlist row of a key, or a field error on `key` when the key is not allowlisted. */
export async function requireAllowlistedKey(key: string): Promise<StudioSettingKeyRow> {
  const row = await StudioSettingsRepository.findKey(key)
  if (!row) {
    throw new ValidationError({ key: [`${key} is not an allowlisted Studio setting`] })
  }
  return row
}
