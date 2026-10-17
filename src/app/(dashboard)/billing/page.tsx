import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { db } from '@/shared/lib/db'
import { NotFoundError } from '@/shared/lib/errors'
import { BillingPageContent } from '@/features/billing/components/billing-page-content'
import { PageHeader } from '@/shared/components/composed/page-header'
import { notFoundInSelfHosted } from '@/shared/lib/deployment'

export default async function BillingPage() {
  await notFoundInSelfHosted()
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.BILLING_VIEW)

  const tenantId = user.currentTenantId
  if (!tenantId) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Billing" description="Please select a tenant first." />
      </div>
    )
  }

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    include: {
      planConfig: true,
      // The plan limit counts the connections that are not deleted.
      _count: { select: { members: true, connections: { where: { deletedAt: null } } } },
    },
  })

  if (!tenant) throw new NotFoundError('Tenant')

  const allPlans = await db.planConfig.findMany({
    orderBy: { sortOrder: 'asc' },
  })

  const billingEnabled = process.env.BILLING_ENABLED === 'true'

  const plan = tenant.planConfig

  const serializePlan = (p: typeof plan) => ({
    code: p.code,
    name: p.name,
    description: p.description,
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
  })

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Billing" description="Manage your subscription and view usage." />
      <BillingPageContent
        currentPlan={serializePlan(plan)}
        usage={{
          currentUsers: tenant._count.members,
          currentConnections: tenant._count.connections,
        }}
        allPlans={allPlans.map(serializePlan)}
        billingEnabled={billingEnabled}
      />
    </div>
  )
}
