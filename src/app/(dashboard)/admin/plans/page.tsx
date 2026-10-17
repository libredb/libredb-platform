import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { db } from '@/shared/lib/db'
import { PlanList } from '@/features/tenants/components/plan-list'
import { notFoundInSelfHosted } from '@/shared/lib/deployment'

export default async function PlansPage() {
  await notFoundInSelfHosted()
  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const plans = await db.planConfig.findMany({
    orderBy: { sortOrder: 'asc' },
  })

  const serialized = plans.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    isDefault: p.isDefault,
    sortOrder: p.sortOrder,
    maxUsers: p.maxUsers,
    maxConnections: p.maxConnections,
    queryHistoryDays: p.queryHistoryDays,
    featureSharedQueries: p.featureSharedQueries,
    featureAdvancedRbac: p.featureAdvancedRbac,
    featureAuditLog: p.featureAuditLog,
    featurePerfTracking: p.featurePerfTracking,
    featureDataMasking: p.featureDataMasking,
    featureSamlSso: p.featureSamlSso,
    featureScimProvisioning: p.featureScimProvisioning,
    featureSelfHosted: p.featureSelfHosted,
    featureApiAccess: p.featureApiAccess,
    pricePerUserMonthly: p.pricePerUserMonthly?.toString() ?? null,
  }))

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Plans Management</h1>
        <p className="text-sm text-muted-foreground">
          Configure plan limits, features, and pricing.
        </p>
      </div>
      <PlanList plans={serialized} />
    </div>
  )
}
