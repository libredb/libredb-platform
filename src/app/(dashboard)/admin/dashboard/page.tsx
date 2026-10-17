import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { AdminStatsRepository } from '@/features/tenants/lib/admin-stats.repository'
import { AdminDashboard } from '@/features/tenants/components/admin-dashboard'
import { PageHeader } from '@/shared/components/composed/page-header'

export default async function AdminDashboardPage() {
  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const [stats, recentTenants] = await Promise.all([
    AdminStatsRepository.getStats(),
    AdminStatsRepository.getRecentTenants(),
  ])

  const serializedTenants = recentTenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    active: t.active,
    createdAt: t.createdAt.toISOString(),
    planConfig: t.planConfig,
    _count: t._count,
  }))

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Admin Dashboard" description="Platform overview and statistics." />
      <AdminDashboard stats={stats} recentTenants={serializedTenants} />
    </div>
  )
}
