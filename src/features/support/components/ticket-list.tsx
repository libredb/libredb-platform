'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PlusIcon, MessageSquareIcon } from 'lucide-react'
import { type ColumnDef } from '@tanstack/react-table'
import { buttonVariants } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { PageHeader } from '@/shared/components/composed/page-header'
import { DataTable, SortableHeader } from '@/shared/components/composed/data-table'
import { EmptyState } from '@/shared/components/composed/empty-state'

interface ReferenceValueItem {
  code: string
  name: string
  colorCode: string | null
}

interface TicketListItem {
  id: string
  ticketNumber: string
  subject: string
  status: string
  priority: string
  category: string
  createdByUserId: string
  createdAt: string
  updatedAt: string
}

interface TicketListProps {
  tickets: TicketListItem[]
  canCreate: boolean
  statusValues: ReferenceValueItem[]
  priorityValues: ReferenceValueItem[]
  categoryValues: ReferenceValueItem[]
  userMap: Record<string, string>
}

function getPriorityVariant(priorityCode: string): 'destructive' | 'warning' | 'secondary' | 'outline' {
  switch (priorityCode) {
    case 'CRITICAL':
      return 'destructive'
    case 'HIGH':
      return 'warning'
    case 'MEDIUM':
      return 'secondary'
    case 'LOW':
    default:
      return 'outline'
  }
}

function getColorStyle(colorCode: string | null | undefined) {
  if (!colorCode) return {}
  return {
    backgroundColor: `${colorCode}20`,
    color: colorCode,
    borderColor: `${colorCode}40`,
  }
}

export function TicketList({
  tickets,
  canCreate,
  statusValues,
  priorityValues,
  categoryValues,
  userMap,
}: TicketListProps) {
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [priorityFilter, setPriorityFilter] = useState<string>('ALL')
  const router = useRouter()

  const statusMap = Object.fromEntries(statusValues.map((v) => [v.code, v]))
  const priorityMap = Object.fromEntries(priorityValues.map((v) => [v.code, v]))
  const categoryMap = Object.fromEntries(categoryValues.map((v) => [v.code, v]))

  // A filter's items give its trigger the name of the chosen value instead of ALL or the code.
  const statusItems = [
    { value: 'ALL', label: 'All Statuses' },
    ...statusValues.map((s) => ({ value: s.code, label: s.name })),
  ]
  const priorityItems = [
    { value: 'ALL', label: 'All Priorities' },
    ...priorityValues.map((p) => ({ value: p.code, label: p.name })),
  ]

  const filtered = tickets.filter((t) => {
    if (statusFilter !== 'ALL' && t.status !== statusFilter) return false
    if (priorityFilter !== 'ALL' && t.priority !== priorityFilter) return false
    return true
  })

  const columns: ColumnDef<TicketListItem>[] = [
    {
      accessorKey: 'ticketNumber',
      header: 'Ticket #',
      cell: ({ row }) => (
        <span className="font-mono text-sm">{row.original.ticketNumber}</span>
      ),
      size: 120,
    },
    {
      accessorKey: 'subject',
      header: ({ column }) => <SortableHeader column={column}>Subject</SortableHeader>,
      cell: ({ row }) => (
        <span className="font-medium">{row.original.subject}</span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const sv = statusMap[row.original.status]
        return (
          <Badge
            variant="outline"
            className="border text-xs"
            style={getColorStyle(sv?.colorCode)}
          >
            {sv?.name ?? row.original.status}
          </Badge>
        )
      },
      size: 110,
    },
    {
      accessorKey: 'priority',
      header: 'Priority',
      cell: ({ row }) => {
        const pv = priorityMap[row.original.priority]
        return (
          <Badge variant={getPriorityVariant(row.original.priority)} className="text-xs">
            {pv?.name ?? row.original.priority}
          </Badge>
        )
      },
      size: 110,
    },
    {
      accessorKey: 'category',
      header: 'Category',
      cell: ({ row }) => {
        const cv = categoryMap[row.original.category]
        return (
          <Badge variant="secondary" className="text-xs">
            {cv?.name ?? row.original.category}
          </Badge>
        )
      },
      size: 110,
    },
    {
      id: 'createdBy',
      header: 'Created By',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {userMap[row.original.createdByUserId] ?? 'Unknown'}
        </span>
      ),
      size: 140,
    },
    {
      id: 'updatedAt',
      header: 'Updated',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {new Date(row.original.updatedAt).toLocaleDateString()}
        </span>
      ),
      size: 140,
    },
  ]

  const toolbar = (
    <>
      <Select items={statusItems} value={statusFilter} onValueChange={(value) => setStatusFilter(value ?? 'ALL')}>
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {statusItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select items={priorityItems} value={priorityFilter} onValueChange={(value) => setPriorityFilter(value ?? 'ALL')}>
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder="Priority" />
        </SelectTrigger>
        <SelectContent>
          {priorityItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )

  return (
    <div className="space-y-6">
      <PageHeader title="Support" description="View and manage support tickets.">
        {canCreate && (
          <Link href="/support/new" className={buttonVariants()}>
            <PlusIcon className="size-4" />
            New Ticket
          </Link>
        )}
      </PageHeader>

      <DataTable
        columns={columns}
        data={filtered}
        globalSearch
        searchPlaceholder="Search tickets..."
        onRowClick={(row) => router.push(`/support/${row.id}`)}
        toolbar={toolbar}
        pageSize={20}
        emptyState={
          <EmptyState
            icon={MessageSquareIcon}
            title="No support tickets"
            description={
              statusFilter !== 'ALL' || priorityFilter !== 'ALL'
                ? 'No tickets match your current filters.'
                : 'Create a ticket to get help from our team.'
            }
          />
        }
      />
    </div>
  )
}
