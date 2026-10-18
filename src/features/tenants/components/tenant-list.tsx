'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type ColumnDef } from '@tanstack/react-table'
import {
  BuildingIcon,
  PlusIcon,
  MoreHorizontalIcon,
  PowerIcon,
  PowerOffIcon,
  ExternalLinkIcon,
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Badge } from '@/shared/components/ui/badge'
import { Button, buttonVariants } from '@/shared/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import {
  DataTable,
  SortableHeader,
} from '@/shared/components/composed/data-table'
import { EmptyState } from '@/shared/components/composed/empty-state'
import { UsageBar } from '@/shared/components/composed/usage-bar'
import { useAction } from '@/shared/hooks/use-action'
import { updateTenant } from '../actions/update-tenant'
import { planBadgeVariant } from '../lib/plan-badge'

export interface TenantListItem {
  id: string
  name: string
  slug: string
  active: boolean
  createdAt: string
  planConfig: {
    id: string
    code: string
    name: string
    maxUsers: number
    maxConnections: number
  } | null
  _count: { members: number; connections: number }
}

interface TenantListProps {
  tenants: TenantListItem[]
}

export function TenantList({ tenants }: TenantListProps) {
  const router = useRouter()
  const { execute: executeUpdate, isPending } = useAction(updateTenant, {
    successMessage: 'Tenant updated',
  })

  const handleToggleActive = (tenant: TenantListItem) => {
    executeUpdate({ id: tenant.id, active: !tenant.active })
  }

  const columns: ColumnDef<TenantListItem>[] = [
    {
      id: 'name',
      accessorFn: (row) => row.name,
      header: ({ column }) => (
        <SortableHeader column={column}>Name</SortableHeader>
      ),
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">
            {row.original.name}
          </span>
          <span className="text-xs text-muted-foreground">
            {row.original.slug}
          </span>
        </div>
      ),
    },
    {
      id: 'plan',
      accessorFn: (row) => row.planConfig?.name ?? '',
      header: 'Plan',
      cell: ({ row }) => {
        const plan = row.original.planConfig
        if (!plan) return <span className="text-muted-foreground">-</span>
        return (
          <Badge variant={planBadgeVariant(plan.code)}>{plan.name}</Badge>
        )
      },
    },
    {
      id: 'members',
      accessorFn: (row) => row._count.members,
      header: ({ column }) => (
        <SortableHeader column={column}>Members</SortableHeader>
      ),
      cell: ({ row }) => (
        <UsageBar
          compact
          used={row.original._count.members}
          limit={row.original.planConfig?.maxUsers ?? -1}
        />
      ),
    },
    {
      id: 'connections',
      accessorFn: (row) => row._count.connections,
      header: ({ column }) => (
        <SortableHeader column={column}>Connections</SortableHeader>
      ),
      cell: ({ row }) => (
        <UsageBar
          compact
          used={row.original._count.connections}
          limit={row.original.planConfig?.maxConnections ?? -1}
        />
      ),
    },
    {
      id: 'status',
      accessorFn: (row) => (row.active ? 'active' : 'inactive'),
      header: 'Status',
      cell: ({ row }) =>
        row.original.active ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500 dark:text-emerald-400">
            <span className="inline-block size-1.5 rounded-full bg-current" />
            Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="inline-block size-1.5 rounded-full border border-current" />
            Inactive
          </span>
        ),
    },
    {
      id: 'createdAt',
      accessorFn: (row) => row.createdAt,
      header: ({ column }) => (
        <SortableHeader column={column}>Created</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatDistanceToNow(new Date(row.original.createdAt), {
            addSuffix: true,
          })}
        </span>
      ),
    },
    {
      id: 'actions',
      header: () => null,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" />}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontalIcon className="size-4" />
            <span className="sr-only">Actions for {row.original.name}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => router.push(`/admin/tenants/${row.original.id}`)}
              >
                <ExternalLinkIcon className="size-4" />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleToggleActive(row.original)}
                disabled={isPending}
                variant={row.original.active ? 'destructive' : undefined}
              >
                {row.original.active ? (
                  <>
                    <PowerOffIcon className="size-4" />
                    Deactivate
                  </>
                ) : (
                  <>
                    <PowerIcon className="size-4" />
                    Activate
                  </>
                )}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
      size: 48,
    },
  ]

  return (
    <DataTable
      columns={columns}
      data={tenants}
      globalSearch
      searchPlaceholder="Search tenants..."
      pageSize={15}
      onRowClick={(tenant) => router.push(`/admin/tenants/${tenant.id}`)}
      toolbar={
        <Link href="/admin/tenants/new" className={buttonVariants()}>
          <PlusIcon className="size-4" />
          New Tenant
        </Link>
      }
      emptyState={
        <EmptyState
          icon={BuildingIcon}
          title="No tenants yet"
          description="Create your first tenant to get started."
        />
      }
    />
  )
}
