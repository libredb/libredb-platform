'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import {
  LayoutDashboardIcon,
  UsersIcon,
  DatabaseIcon,
  ActivityIcon,
  SettingsIcon,
} from 'lucide-react'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/shared/components/ui/tabs'
import {
  TenantOverviewTab,
  type TenantOverviewData,
} from './tenant-overview-tab'
import {
  TenantMembersTab,
  type MemberView,
} from './tenant-members-tab'
import {
  TenantConnectionsTab,
  type ConnectionView,
} from './tenant-connections-tab'
import { ActivityFeed, type ActivityItem } from './tenant-activity-feed'
import { TenantForm } from './tenant-form'

interface TenantDetailTabsProps {
  tenant: TenantOverviewData
  members: MemberView[]
  connections: ConnectionView[]
  allActivity: ActivityItem[]
  plans: { id: string; code: string; name: string }[]
  formInitial: {
    id: string
    name: string
    slug: string
    planConfigId: string
    active: boolean
  }
}

const VALID_TABS = ['overview', 'members', 'connections', 'activity', 'settings'] as const
type TabKey = (typeof VALID_TABS)[number]

export function TenantDetailTabs({
  tenant,
  members,
  connections,
  allActivity,
  plans,
  formInitial,
}: TenantDetailTabsProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const raw = searchParams.get('tab')
  const active: TabKey =
    raw && (VALID_TABS as readonly string[]).includes(raw)
      ? (raw as TabKey)
      : 'overview'

  const setTab = (next: string | null) => {
    if (!next) return
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'overview') {
      params.delete('tab')
    } else {
      params.set('tab', next)
    }
    const qs = params.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }

  return (
    <Tabs value={active} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="overview">
          <LayoutDashboardIcon className="size-4" />
          Overview
        </TabsTrigger>
        <TabsTrigger value="members">
          <UsersIcon className="size-4" />
          Members ({members.length})
        </TabsTrigger>
        <TabsTrigger value="connections">
          <DatabaseIcon className="size-4" />
          Connections ({connections.length})
        </TabsTrigger>
        <TabsTrigger value="activity">
          <ActivityIcon className="size-4" />
          Activity
        </TabsTrigger>
        <TabsTrigger value="settings">
          <SettingsIcon className="size-4" />
          Settings
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="mt-6">
        <TenantOverviewTab tenant={tenant} />
      </TabsContent>

      <TabsContent value="members" className="mt-6">
        <TenantMembersTab members={members} />
      </TabsContent>

      <TabsContent value="connections" className="mt-6">
        <TenantConnectionsTab connections={connections} />
      </TabsContent>

      <TabsContent value="activity" className="mt-6">
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-4 font-heading text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Activity Feed
          </h3>
          <ActivityFeed items={allActivity} />
        </div>
      </TabsContent>

      <TabsContent value="settings" className="mt-6">
        <div className="rounded-lg border border-border bg-card p-5">
          <TenantForm plans={plans} tenant={formInitial} />
        </div>
      </TabsContent>
    </Tabs>
  )
}
