import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { TenantRepository } from '@/features/tenants/lib/tenant.repository'
import { TenantForm } from '@/features/tenants/components/tenant-form'
import { notFoundInSelfHosted } from '@/shared/lib/deployment'

export default async function NewTenantPage() {
  await notFoundInSelfHosted()
  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const plans = await TenantRepository.findAllPlanConfigs()

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New Tenant</h1>
        <p className="text-sm text-muted-foreground">
          Create a new tenant on the platform.
        </p>
      </div>
      <TenantForm plans={plans} />
    </div>
  )
}
