import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { isSelfHosted } from '@/shared/lib/deployment'
import { PageHeader } from '@/shared/components/composed/page-header'
import { StudioSettingsForm, StudioSettingsRepository } from '@/features/studio-settings'

// Studio reads its runtime settings from a self-hosted install only, so cloud mode answers 404.
// The mode is read per request, never at build time, so one build serves both modes.
export default async function StudioSettingsPage() {
  await connection()
  if (!isSelfHosted()) notFound()

  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.SETTINGS_EDIT)

  const settings = await StudioSettingsRepository.listFields()

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Studio settings"
        description="Runtime settings that every Studio instance of this install reads from Platform."
      />
      <StudioSettingsForm settings={settings} />
    </div>
  )
}
