import Link from 'next/link'
import { ArrowLeftIcon } from 'lucide-react'
import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { TenantRepository } from '@/features/tenants/lib/tenant.repository'
import { TenantDetailTabs } from '@/features/tenants/components/tenant-detail-tabs'
import { planBadgeVariant } from '@/features/tenants/lib/plan-badge'
import { Badge } from '@/shared/components/ui/badge'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { notFoundInSelfHosted } from '@/shared/lib/deployment'

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await notFoundInSelfHosted()
  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const { id } = await params

  const [tenant, plans, activity] = await Promise.all([
    TenantRepository.findByIdWithDetails(id),
    TenantRepository.findAllPlanConfigs(),
    TenantRepository.findRecentActivity(id, 40),
  ])

  const overviewData = {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    active: tenant.active,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
    planConfig: tenant.planConfig
      ? {
          id: tenant.planConfig.id,
          code: tenant.planConfig.code,
          name: tenant.planConfig.name,
          maxUsers: tenant.planConfig.maxUsers,
          maxConnections: tenant.planConfig.maxConnections,
          queryHistoryDays: tenant.planConfig.queryHistoryDays,
        }
      : null,
    subscription: tenant.subscription
      ? {
          status: tenant.subscription.status,
          currentPeriodStart:
            tenant.subscription.currentPeriodStart?.toISOString() ?? null,
          currentPeriodEnd:
            tenant.subscription.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: tenant.subscription.cancelAtPeriodEnd,
          stripeCustomerId: tenant.subscription.stripeCustomerId,
        }
      : null,
    counts: tenant._count,
    recentActivity: activity.slice(0, 8).map((a) => ({
      ...a,
      at: a.at.toISOString(),
    })),
  }

  const allActivity = activity.map((a) => ({ ...a, at: a.at.toISOString() }))

  const members = tenant.members.map((m) => ({
    id: m.id,
    isDefault: m.isDefault,
    active: m.active,
    user: {
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      avatarUrl: m.user.avatarUrl,
      lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
      active: m.user.active,
    },
    roles: m.roles.map((r) => ({
      role: { code: r.role.code, name: r.role.name },
    })),
  }))

  const connections = tenant.connections.map((c) => ({
    id: c.id,
    name: c.name,
    engine: c.engine,
    hostSummary: c.hostSummary,
    active: c.active,
    createdAt: c.createdAt.toISOString(),
  }))

  return (
    <div className="space-y-6 p-6">
      {/* Back link */}
      <div>
        <Link
          href="/admin/tenants"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <ArrowLeftIcon className="size-4" />
          Back to tenants
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {tenant.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono text-xs">{tenant.slug}</span>
            <span>·</span>
            {tenant.planConfig && (
              <>
                <Badge variant={planBadgeVariant(tenant.planConfig.code)}>
                  {tenant.planConfig.name}
                </Badge>
                <span>·</span>
              </>
            )}
            {tenant.active ? (
              <Badge variant="success">Active</Badge>
            ) : (
              <Badge variant="destructive">Inactive</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <TenantDetailTabs
        tenant={overviewData}
        members={members}
        connections={connections}
        allActivity={allActivity}
        plans={plans}
        formInitial={{
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          planConfigId: tenant.planConfigId,
          active: tenant.active,
        }}
      />
    </div>
  )
}
