import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { isSelfHosted } from '@/shared/lib/deployment'
import { PageHeader } from '@/shared/components/composed/page-header'
import { DirectoryDegradedBanner } from '@/shared/components/feedback/directory-degraded-banner'
import { StudioUsersTable, loadStudioUsers, parseStudioUsersQuery } from '@/features/studio-users'

// Studio users come from the Keycloak directory of a self-hosted install, so cloud mode answers 404.
// The mode is read per request, never at build time, so one build serves both modes.
export default async function StudioUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await connection()
  if (!isSelfHosted()) notFound()

  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const query = parseStudioUsersQuery(await searchParams)
  const listing = await loadStudioUsers(user, query)

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Studio users"
        description="The users who hold the admin or user role in Keycloak, directly or through a group."
      />
      <p className="text-sm text-muted-foreground">A role held only through a composite role is not listed.</p>
      {listing.status === 'listed' && <StudioUsersTable page={listing.page} search={query.search} />}
      {/* A degraded session gets the banner from the dashboard layout; this one covers a Keycloak that stopped
          answering before the session recheck noticed. */}
      {listing.status === 'directory-unreachable' && <DirectoryDegradedBanner directoryDegraded />}
    </div>
  )
}
