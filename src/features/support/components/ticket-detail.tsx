'use client'

import { useRouter } from 'next/navigation'
import { Badge } from '@/shared/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useAction } from '@/shared/hooks/use-action'
import { updateTicket } from '../actions/update-ticket'

interface ReferenceValueItem {
  code: string
  name: string
  colorCode: string | null
}

interface MemberItem {
  userId: string
  userName: string
}

interface TicketDetailProps {
  ticket: {
    id: string
    ticketNumber: string
    subject: string
    description: string | null
    status: string
    priority: string
    category: string
    createdByUserId: string
    assignedToUserId: string | null
    resolvedAt: string | null
    closedAt: string | null
    satisfactionRating: number | null
    createdAt: string
    updatedAt: string
  }
  canManage: boolean
  statusValues: ReferenceValueItem[]
  priorityValues: ReferenceValueItem[]
  categoryValues: ReferenceValueItem[]
  members: MemberItem[]
  userMap: Record<string, string>
}

function getColorStyle(colorCode: string | null | undefined) {
  if (!colorCode) return {}
  return {
    backgroundColor: `${colorCode}20`,
    color: colorCode,
    borderColor: `${colorCode}40`,
  }
}

export function TicketDetail({
  ticket,
  canManage,
  statusValues,
  priorityValues,
  categoryValues,
  members,
  userMap,
}: TicketDetailProps) {
  const router = useRouter()

  const { execute: executeUpdate } = useAction(updateTicket, {
    successMessage: 'Ticket updated',
  })

  const statusRef = statusValues.find((v) => v.code === ticket.status)
  const priorityRef = priorityValues.find((v) => v.code === ticket.priority)
  const categoryRef = categoryValues.find((v) => v.code === ticket.category)

  const handleStatusChange = (value: string | null) => {
    if (!value) return
    executeUpdate({ id: ticket.id, status: value })
  }

  const handlePriorityChange = (value: string | null) => {
    if (!value) return
    executeUpdate({ id: ticket.id, priority: value })
  }

  const handleCategoryChange = (value: string | null) => {
    if (!value) return
    executeUpdate({ id: ticket.id, category: value })
  }

  const handleAssignChange = (value: string | null) => {
    if (!value) return
    executeUpdate({
      id: ticket.id,
      assignedToUserId: value === 'UNASSIGNED' ? null : value,
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">
              {ticket.ticketNumber}
            </span>
            <Badge
              variant="outline"
              className="border text-xs"
              style={getColorStyle(statusRef?.colorCode)}
            >
              {statusRef?.name ?? ticket.status}
            </Badge>
            <Badge
              variant="outline"
              className="border text-xs"
              style={getColorStyle(priorityRef?.colorCode)}
            >
              {priorityRef?.name ?? ticket.priority}
            </Badge>
          </div>
          <h2 className="text-xl font-semibold">{ticket.subject}</h2>
        </div>
      </div>

      {/* Details grid */}
      <div className="grid gap-6 md:grid-cols-[1fr_280px]">
        {/* Description */}
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span>Created by {userMap[ticket.createdByUserId] ?? 'Unknown'}</span>
              <span>on {new Date(ticket.createdAt).toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4 space-y-4">
            {/* Status */}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Status</span>
              {canManage ? (
                <Select value={ticket.status} onValueChange={handleStatusChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statusValues.map((s) => (
                      <SelectItem key={s.code} value={s.code}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Badge
                  variant="outline"
                  className="border text-xs"
                  style={getColorStyle(statusRef?.colorCode)}
                >
                  {statusRef?.name ?? ticket.status}
                </Badge>
              )}
            </div>

            {/* Priority */}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Priority</span>
              {canManage ? (
                <Select value={ticket.priority} onValueChange={handlePriorityChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {priorityValues.map((p) => (
                      <SelectItem key={p.code} value={p.code}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Badge
                  variant="outline"
                  className="border text-xs"
                  style={getColorStyle(priorityRef?.colorCode)}
                >
                  {priorityRef?.name ?? ticket.priority}
                </Badge>
              )}
            </div>

            {/* Category */}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Category</span>
              {canManage ? (
                <Select value={ticket.category} onValueChange={handleCategoryChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryValues.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Badge variant="secondary" className="text-xs">
                  {categoryRef?.name ?? ticket.category}
                </Badge>
              )}
            </div>

            {/* Assigned To */}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Assigned To</span>
              {canManage ? (
                <Select
                  value={ticket.assignedToUserId ?? 'UNASSIGNED'}
                  onValueChange={handleAssignChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UNASSIGNED">Unassigned</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.userName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-sm">
                  {ticket.assignedToUserId
                    ? (userMap[ticket.assignedToUserId] ?? 'Unknown')
                    : 'Unassigned'}
                </p>
              )}
            </div>

            {/* Timestamps */}
            <div className="space-y-2 border-t pt-3">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Created</span>
                <span>{new Date(ticket.createdAt).toLocaleDateString()}</span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Updated</span>
                <span>{new Date(ticket.updatedAt).toLocaleDateString()}</span>
              </div>
              {ticket.resolvedAt && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Resolved</span>
                  <span>{new Date(ticket.resolvedAt).toLocaleDateString()}</span>
                </div>
              )}
              {ticket.closedAt && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Closed</span>
                  <span>{new Date(ticket.closedAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
