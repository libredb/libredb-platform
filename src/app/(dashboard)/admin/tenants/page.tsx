import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { TenantRepository } from '@/features/tenants/lib/tenant.repository'
import { TenantList } from '@/features/tenants/components/tenant-list'
import { TenantStats } from '@/features/tenants/components/tenant-stats'
import { PageHeader } from '@/shared/components/composed/page-header'
import { notFoundInSelfHosted } from '@/shared/lib/deployment'

export default async function TenantsPage() {
  await notFoundInSelfHosted()
  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const [tenants, stats] = await Promise.all([
    TenantRepository.findAll(),
    TenantRepository.getAdminStats(),
  ])

  const serialized = tenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    active: t.active,
    createdAt: t.createdAt.toISOString(),
    planConfig: t.planConfig
      ? {
          id: t.planConfig.id,
          code: t.planConfig.code,
          name: t.planConfig.name,
          maxUsers: t.planConfig.maxUsers,
          maxConnections: t.planConfig.maxConnections,
        }
      : null,
    _count: t._count,
  }))

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Tenant Management"
        description="Platform tenant lifecycle, usage, and governance."
      />
      <TenantStats {...stats} />
      <TenantList tenants={serialized} />
    </div>
  )
}
