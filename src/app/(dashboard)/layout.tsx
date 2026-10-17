import { Suspense } from 'react'
import { requireAuth } from '@/shared/lib/auth-utils'
import { getAuthorizedMenus } from '@/shared/lib/menu'
import { getDeploymentMode } from '@/shared/lib/deployment'
import { getLicenseNotice } from '@/shared/lib/license/install-license-notice'
import type { CurrentUser } from '@/shared/types'
import { SidebarInset, SidebarProvider } from '@/shared/components/ui/sidebar'
import { AppSidebar } from '@/shared/components/layout/app-sidebar'
import { AppHeader } from '@/shared/components/layout/app-header'
import { DirectoryDegradedBanner } from '@/shared/components/feedback/directory-degraded-banner'
import { LicenseBanner } from '@/shared/components/feedback/license-banner'

// The license banner counts the seats in use and may ask Keycloak about the admins, so it streams in after the page
// instead of holding the page up while Keycloak is slow.
async function InstallLicenseBanner({ user }: { user: CurrentUser }) {
  return <LicenseBanner notice={await getLicenseNotice(user)} className="mx-6 mt-6 w-auto" />
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAuth()
  const menus = await getAuthorizedMenus(user.roles)

  const currentTenant = user.accessibleTenants.find(t => t.id === user.currentTenantId) ?? null

  return (
    <SidebarProvider>
      <AppSidebar deploymentMode={getDeploymentMode()} menus={menus} user={user} currentTenant={currentTenant} />
      <SidebarInset>
        <AppHeader />
        <main>
          <DirectoryDegradedBanner directoryDegraded={user.directoryDegraded} className="mx-6 mt-6 w-auto" />
          <Suspense fallback={null}>
            <InstallLicenseBanner user={user} />
          </Suspense>
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
