'use client'

import Link from 'next/link'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { SlaBadge } from './sla-badge'
import { TagPicker } from './tag-picker'
import { format } from 'date-fns'

interface ReferenceValue { code: string; name: string; colorCode: string | null }
interface MemberItem { userId: string; userName: string }
interface TagItem { id: string; name: string; colorCode: string | null; tenantId: string | null }

interface ConversationSidebarProps {
  ticket: any
  canManage: boolean
  statusValues: ReferenceValue[]
  priorityValues: ReferenceValue[]
  categoryValues: ReferenceValue[]
  members: MemberItem[]
  /** Display names by user id of the users the ticket page loaded, the assignee among them. */
  userMap: Record<string, string>
  tags: TagItem[]
  availableTags: TagItem[]
  onStatusChange: (v: string) => void
  onPriorityChange: (v: string) => void
  onCategoryChange: (v: string) => void
  onAssigneeChange: (v: string | null) => void
  onTagAdd: (tagId: string) => void
  onTagRemove: (tagId: string) => void
  customerName: string
  customerEmail: string | null
  tenantName: string | null
  tenantSlug: string | null
  tenantPlan: string | null
}

const UNASSIGNED = 'UNASSIGNED'

/** A select's items, which give its trigger the name of the selected value instead of the value itself. */
function referenceItems(values: ReferenceValue[]) {
  return values.map(v => ({ value: v.code, label: v.name }))
}

export function ConversationSidebar(props: ConversationSidebarProps) {
  const { ticket, canManage, members, statusValues, priorityValues, categoryValues, tags, availableTags } = props
  const assigneeId: string | null = ticket.assignedToUserId ?? null
  // The staff options hold ten people at most, so they can miss the assignee, who then gets an option of their own.
  const assigneeItems = [
    { value: UNASSIGNED, label: 'Unassigned' },
    ...members.map(m => ({ value: m.userId, label: m.userName })),
    ...(assigneeId && !members.some(m => m.userId === assigneeId)
      ? [{ value: assigneeId, label: props.userMap[assigneeId] ?? 'Unknown user' }]
      : []),
  ]
  const statusItems = referenceItems(statusValues)
  const priorityItems = referenceItems(priorityValues)
  const categoryItems = referenceItems(categoryValues)

  return (
    <aside className="w-[220px] shrink-0 space-y-4 border-l bg-card p-4 text-xs">
      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Customer</div>
        <div className="font-medium">{props.customerName}</div>
        {props.customerEmail && <div className="text-muted-foreground">{props.customerEmail}</div>}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Tenant</div>
        {props.tenantSlug
          ? <Link href={`/tenants/${props.tenantSlug}`} className="font-medium underline underline-offset-2">{props.tenantName}</Link>
          : <span className="italic text-muted-foreground">Internal (libredb staff)</span>}
        {props.tenantPlan && <div className="text-muted-foreground">{props.tenantPlan}</div>}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Assigned To</div>
        {canManage ? (
          <Select items={assigneeItems} value={assigneeId ?? UNASSIGNED} onValueChange={v => props.onAssigneeChange(v === UNASSIGNED ? null : v)}>
            <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {assigneeItems.map(a => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <span>{ticket.assignedToUserId ? (members.find(m => m.userId === ticket.assignedToUserId)?.userName ?? 'Assigned') : 'Unassigned'}</span>
        )}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Status</div>
        {canManage ? (
          <Select items={statusItems} value={ticket.status} onValueChange={props.onStatusChange}>
            <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{statusItems.map(i => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}</SelectContent>
          </Select>
        ) : <span>{statusValues.find(s => s.code === ticket.status)?.name}</span>}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Priority</div>
        {canManage ? (
          <Select items={priorityItems} value={ticket.priority} onValueChange={props.onPriorityChange}>
            <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{priorityItems.map(i => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}</SelectContent>
          </Select>
        ) : <span>{priorityValues.find(p => p.code === ticket.priority)?.name}</span>}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Category</div>
        {canManage ? (
          <Select items={categoryItems} value={ticket.category} onValueChange={props.onCategoryChange}>
            <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{categoryItems.map(i => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}</SelectContent>
          </Select>
        ) : <span>{categoryValues.find(c => c.code === ticket.category)?.name}</span>}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Tags</div>
        <TagPicker ticketTags={tags} availableTags={availableTags} canManage={canManage} onAdd={props.onTagAdd} onRemove={props.onTagRemove} />
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">SLA</div>
        <SlaBadge ticket={ticket} />
      </section>

      <section className="space-y-1 border-t pt-3">
        <div className="flex justify-between text-muted-foreground">
          <span>Created</span><time>{format(new Date(ticket.createdAt), 'd MMM · HH:mm')}</time>
        </div>
        {ticket.firstResponseAt && (
          <div className="flex justify-between text-muted-foreground">
            <span>First response</span><time>{format(new Date(ticket.firstResponseAt), 'd MMM · HH:mm')}</time>
          </div>
        )}
        {ticket.resolvedAt && (
          <div className="flex justify-between text-muted-foreground">
            <span>Resolved</span><time>{format(new Date(ticket.resolvedAt), 'd MMM · HH:mm')}</time>
          </div>
        )}
        {ticket.reopenedCount > 0 && (
          <div className="flex justify-between text-muted-foreground">
            <span>Reopen</span><span>{ticket.reopenedCount}x</span>
          </div>
        )}
      </section>
    </aside>
  )
}
