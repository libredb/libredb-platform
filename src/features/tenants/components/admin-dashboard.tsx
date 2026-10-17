'use client'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { BuildingIcon, UsersIcon, DatabaseIcon, SearchIcon } from 'lucide-react'
import { StatCard } from '@/shared/components/composed/stat-card'

interface StatsData {
  tenants: number
  activeTenants: number
  users: number
  connections: number
  queriesToday: number
}

interface RecentTenant {
  id: string
  name: string
  slug: string
  active: boolean
  createdAt: string
  planConfig: { code: string; name: string }
  _count: { members: number; connections: number }
}

interface AdminDashboardProps {
  stats: StatsData
  recentTenants: RecentTenant[]
}

export function AdminDashboard({ stats, recentTenants }: AdminDashboardProps) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Tenants"
          value={stats.tenants}
          icon={BuildingIcon}
          trend={{ value: `${stats.activeTenants} active`, positive: true }}
        />
        <StatCard
          title="Active Users"
          value={stats.users}
          icon={UsersIcon}
        />
        <StatCard
          title="Connections"
          value={stats.connections}
          icon={DatabaseIcon}
        />
        <StatCard
          title="Queries Today"
          value={stats.queriesToday}
          icon={SearchIcon}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Tenants</CardTitle>
          <CardDescription>Latest tenant registrations</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Connections</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentTenants.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No tenants yet.
                  </TableCell>
                </TableRow>
              ) : (
                recentTenants.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="font-mono text-xs">{t.slug}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t.planConfig.name}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">{t._count.members}</TableCell>
                    <TableCell className="tabular-nums">{t._count.connections}</TableCell>
                    <TableCell>
                      <Badge variant={t.active ? 'success' : 'outline'}>
                        {t.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(t.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
