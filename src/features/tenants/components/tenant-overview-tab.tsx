import Link from 'next/link'
import {
  CalendarIcon,
  CreditCardIcon,
  DatabaseIcon,
  UsersIcon,
  FileTextIcon,
  LifeBuoyIcon,
  MailOpenIcon,
  ShareIcon,
} from 'lucide-react'
import { format, formatDistanceToNow } from 'date-fns'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import { UsageBar } from '@/shared/components/composed/usage-bar'
import { planBadgeVariant } from '../lib/plan-badge'
import { ActivityFeed, type ActivityItem } from './tenant-activity-feed'

export interface TenantOverviewData {
  id: string
  name: string
  slug: string
  createdAt: string
  updatedAt: string
  active: boolean
  planConfig: {
    id: string
    code: string
    name: string
    maxUsers: number
    maxConnections: number
    queryHistoryDays: number
  } | null
  subscription: {
    status: string
    currentPeriodStart: string | null
    currentPeriodEnd: string | null
    cancelAtPeriodEnd: boolean
    stripeCustomerId: string | null
  } | null
  counts: {
    members: number
    connections: number
    queryEvents: number
    tickets: number
    sharedQueries: number
    invitations: number
  }
  recentActivity: ActivityItem[]
}

export function TenantOverviewTab({ tenant }: { tenant: TenantOverviewData }) {
  const plan = tenant.planConfig
  const sub = tenant.subscription

  return (
    <div className="space-y-6">
      {/* Top row: Tenant Info + Subscription */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-4 flex items-center gap-2 font-heading text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <FileTextIcon className="size-4" />
            Tenant Info
          </h3>
          <dl className="space-y-3 text-sm">
            <Row label="Name" value={tenant.name} />
            <Row label="Slug" value={tenant.slug} mono />
            <Row
              label="Created"
              value={format(new Date(tenant.createdAt), 'MMM d, yyyy')}
            />
            <Row
              label="Last Updated"
              value={formatDistanceToNow(new Date(tenant.updatedAt), {
                addSuffix: true,
              })}
            />
            <Row
              label="Status"
              value={
                tenant.active ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Badge variant="destructive">Inactive</Badge>
                )
              }
            />
          </dl>
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-4 flex items-center gap-2 font-heading text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <CreditCardIcon className="size-4" />
            Subscription
          </h3>
          <dl className="space-y-3 text-sm">
            <Row
              label="Plan"
              value={
                plan ? (
                  <Badge variant={planBadgeVariant(plan.code)}>
                    {plan.name}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">No plan</span>
                )
              }
            />
            <Row
              label="Billing Status"
              value={
                sub ? (
                  <Badge
                    variant={
                      sub.status === 'active'
                        ? 'success'
                        : sub.status === 'past_due'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {sub.status}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">Not configured</span>
                )
              }
            />
            {sub?.currentPeriodStart && sub?.currentPeriodEnd && (
              <Row
                label="Current Period"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarIcon className="size-3.5 text-muted-foreground" />
                    {format(new Date(sub.currentPeriodStart), 'MMM d')} to{' '}
                    {format(new Date(sub.currentPeriodEnd), 'MMM d, yyyy')}
                  </span>
                }
              />
            )}
            {sub?.stripeCustomerId && (
              <Row
                label="Stripe Customer"
                value={<span className="font-mono text-xs">{sub.stripeCustomerId}</span>}
              />
            )}
            {sub?.cancelAtPeriodEnd && (
              <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                This subscription will cancel at the end of the period.
              </div>
            )}
          </dl>
        </section>
      </div>

      {/* Usage */}
      <section className="rounded-lg border border-border bg-card p-5">
        <h3 className="mb-4 flex items-center gap-2 font-heading text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <DatabaseIcon className="size-4" />
          Usage
        </h3>
        <div className="grid gap-5 md:grid-cols-2">
          <UsageBar
            label="Members"
            used={tenant.counts.members}
            limit={plan?.maxUsers ?? -1}
          />
          <UsageBar
            label="Connections"
            used={tenant.counts.connections}
            limit={plan?.maxConnections ?? -1}
          />
        </div>
        <Separator className="my-5" />
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <MiniStat
            icon={UsersIcon}
            label="Members"
            value={tenant.counts.members}
          />
          <MiniStat
            icon={DatabaseIcon}
            label="Connections"
            value={tenant.counts.connections}
          />
          <MiniStat
            icon={FileTextIcon}
            label="Query Events"
            value={tenant.counts.queryEvents}
          />
          <MiniStat
            icon={LifeBuoyIcon}
            label="Tickets"
            value={tenant.counts.tickets}
          />
          <MiniStat
            icon={ShareIcon}
            label="Shared Queries"
            value={tenant.counts.sharedQueries}
          />
          <MiniStat
            icon={MailOpenIcon}
            label="Invitations"
            value={tenant.counts.invitations}
          />
        </dl>
      </section>

      {/* Recent Activity */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-heading text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Recent Activity
          </h3>
          <Link
            href={`/admin/tenants/${tenant.id}?tab=activity`}
            className="text-xs text-primary hover:underline"
          >
            View all →
          </Link>
        </div>
        <ActivityFeed items={tenant.recentActivity.slice(0, 8)} />
      </section>
    </div>
  )
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className={mono ? 'font-mono text-xs' : 'text-sm'}>{value}</dd>
    </div>
  )
}

function MiniStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UsersIcon
  label: string
  value: number
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="rounded-md bg-muted p-1.5 dark:bg-white/5">
        <Icon className="size-3.5 text-muted-foreground" />
      </div>
      <div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
      </div>
    </div>
  )
}
