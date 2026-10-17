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

export function ConversationSidebar(props: ConversationSidebarProps) {
  const { ticket, canManage, members, statusValues, priorityValues, categoryValues, tags, availableTags } = props

  return (
    <aside className="w-[220px] shrink-0 space-y-4 border-l bg-card p-4 text-xs">
      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Müşteri</div>
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
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Atanmış</div>
        {canManage ? (
          <Select value={ticket.assignedToUserId ?? 'UNASSIGNED'} onValueChange={v => props.onAssigneeChange(v === 'UNASSIGNED' ? null : v)}>
            <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="UNASSIGNED">Atanmamış</SelectItem>
              {members.map(m => <SelectItem key={m.userId} value={m.userId}>{m.userName}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <span>{ticket.assignedToUserId ? (members.find(m => m.userId === ticket.assignedToUserId)?.userName ?? 'Atanmış') : 'Atanmamış'}</span>
        )}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Durum</div>
        {canManage ? (
          <Select value={ticket.status} onValueChange={props.onStatusChange}>
            <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{statusValues.map(s => <SelectItem key={s.code} value={s.code}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
        ) : <span>{statusValues.find(s => s.code === ticket.status)?.name}</span>}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Öncelik</div>
        {canManage ? (
          <Select value={ticket.priority} onValueChange={props.onPriorityChange}>
            <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{priorityValues.map(p => <SelectItem key={p.code} value={p.code}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
        ) : <span>{priorityValues.find(p => p.code === ticket.priority)?.name}</span>}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Kategori</div>
        {canManage ? (
          <Select value={ticket.category} onValueChange={props.onCategoryChange}>
            <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{categoryValues.map(c => <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        ) : <span>{categoryValues.find(c => c.code === ticket.category)?.name}</span>}
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Etiketler</div>
        <TagPicker ticketTags={tags} availableTags={availableTags} canManage={canManage} onAdd={props.onTagAdd} onRemove={props.onTagRemove} />
      </section>

      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">SLA</div>
        <SlaBadge ticket={ticket} />
      </section>

      <section className="space-y-1 border-t pt-3">
        <div className="flex justify-between text-muted-foreground">
          <span>Açıldı</span><time>{format(new Date(ticket.createdAt), 'd MMM · HH:mm')}</time>
        </div>
        {ticket.firstResponseAt && (
          <div className="flex justify-between text-muted-foreground">
            <span>İlk yanıt</span><time>{format(new Date(ticket.firstResponseAt), 'd MMM · HH:mm')}</time>
          </div>
        )}
        {ticket.resolvedAt && (
          <div className="flex justify-between text-muted-foreground">
            <span>Çözüldü</span><time>{format(new Date(ticket.resolvedAt), 'd MMM · HH:mm')}</time>
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
