import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { isSelfHosted } from '@/shared/lib/deployment'
import { PageHeader } from '@/shared/components/composed/page-header'
import { LicenseOverview, loadLicensePage, parseHoldersPage } from '@/features/license'

// Licensing applies only to a self-hosted install, so cloud mode answers 404. The mode, the license state and the seats
// are read per request, never at build time, so one build serves both modes and the state follows the clock.
export default async function LicensePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await connection()
  if (!isSelfHosted()) notFound()

  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const data = await loadLicensePage(user, parseHoldersPage(await searchParams))

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="License" description="The license of this install and the seats it allows." />
      <LicenseOverview data={data} />
    </div>
  )
}
