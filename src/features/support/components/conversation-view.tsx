'use client'

import { useRef, useState, useMemo, useSyncExternalStore } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { toast } from 'sonner'
import { ConversationHeader } from './conversation-header'
import { ConversationSidebar } from './conversation-sidebar'
import { ConversationTimeline } from './conversation-timeline'
import { ReplyComposer } from './reply-composer'
import { DropzoneOverlay } from './dropzone-overlay'
import { CsatPrompt } from './csat-prompt'
import { useTicket, useSendMessage, useUpdateTicket } from '../hooks/use-ticket'
import { useAttachmentUpload } from '../hooks/use-attachment-upload'
import { addTag } from '../actions/add-tag'
import { removeTag } from '../actions/remove-tag'
import { reopenTicket } from '../actions/reopen-ticket'

interface ConversationViewProps {
  ticketId: string
  initialTicket: any
  currentUserId: string
  canManage: boolean
  canSeeInternal: boolean
  statusValues: any[]
  priorityValues: any[]
  categoryValues: any[]
  members: any[]
  availableTags: any[]
  userMap: Record<string, string>
  statusMap: Record<string, string>
  priorityMap: Record<string, string>
  platformStaffIds: string[]
  customerName: string
  customerEmail: string | null
  tenantName: string | null
  tenantSlug: string | null
  tenantPlan: string | null
}

/**
 * Subscribe to the browser's online/offline state via useSyncExternalStore.
 * This replaces a `useEffect` that called `setOnline(navigator.onLine)` on
 * mount (which tripped the `react-hooks/set-state-in-effect` rule under the
 * React Compiler). The store pattern is SSR-safe (server returns `true`)
 * and avoids the cascading-render hazard.
 */
function subscribeOnline(notify: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('online', notify)
  window.addEventListener('offline', notify)
  return () => {
    window.removeEventListener('online', notify)
    window.removeEventListener('offline', notify)
  }
}
function getOnlineSnapshot(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}
function getOnlineServerSnapshot(): boolean {
  return true
}

export function ConversationView(props: ConversationViewProps) {
  const { data: ticket } = useTicket(props.ticketId, props.initialTicket)
  const send = useSendMessage(props.ticketId)
  const update = useUpdateTicket(props.ticketId)
  const containerRef = useRef<HTMLDivElement>(null)
  const [replyMode, setReplyMode] = useState<'reply' | 'internal'>('reply')
  const globalUpload = useAttachmentUpload()
  const online = useSyncExternalStore(subscribeOnline, getOnlineSnapshot, getOnlineServerSnapshot)
  const staffSet = useMemo(() => new Set(props.platformStaffIds), [props.platformStaffIds])

  // Hotkeys MUST run on every render in the same order (rules-of-hooks).
  // They're declared above the early return below. Callbacks reference
  // `update.mutateAsync` directly so there is no ordering dependency on
  // `handleUpdate` which is defined later.
  useHotkeys('r', (ev) => { ev.preventDefault(); setReplyMode('reply') }, { enableOnFormTags: false })
  useHotkeys('c', (ev) => { if (props.canManage) { ev.preventDefault(); setReplyMode('internal') } }, { enableOnFormTags: false })
  useHotkeys('e', async () => {
    if (!props.canManage) return
    const res = await update.mutateAsync({ status: 'RESOLVED' })
    if (!res.success) toast.error(res.error)
  }, { enableOnFormTags: false })

  if (!ticket) return <div className="flex h-full items-center justify-center text-muted-foreground">Yukleniyor...</div>

  const handleAddTag = async (tagId: string) => {
    const res = await addTag({ ticketId: props.ticketId, tagId })
    if (!res.success) toast.error(res.error)
  }
  const handleRemoveTag = async (tagId: string) => {
    const res = await removeTag({ ticketId: props.ticketId, tagId })
    if (!res.success) toast.error(res.error)
  }

  const handleSend = async (payload: any) => {
    const res = await send.mutateAsync(payload)
    if (res.success) toast.success('Mesaj gonderildi')
    else toast.error(res.error)
  }
  const handleUpdate = async (data: any) => {
    const res = await update.mutateAsync(data)
    if (!res.success) toast.error(res.error)
  }

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1">
      <DropzoneOverlay containerRef={containerRef} onFiles={(files) => { void globalUpload.upload(files) }} />
      <div className="flex min-w-0 flex-1 flex-col">
        {!online && <div className="bg-destructive/10 px-4 py-1 text-xs text-destructive">Baglanti yok, otomatik tekrar denenecek</div>}
        <ConversationHeader
          ticket={{
            id: ticket.id, ticketNumber: ticket.ticketNumber, subject: ticket.subject,
            status: ticket.status, priority: ticket.priority,
            tenantName: props.tenantName, customerName: props.customerName,
          }}
          canManage={props.canManage}
          statusValues={props.statusValues}
          priorityValues={props.priorityValues}
          onResolve={() => handleUpdate({ status: 'RESOLVED' })}
          onReopen={async () => {
            const res = await reopenTicket({ id: props.ticketId })
            if (res.success) toast.success('Yeniden açıldı')
            else toast.error(res.error)
          }}
          onUpdateSubject={(subject) => handleUpdate({ subject })}
        />
        <div className="flex-1 overflow-y-auto p-4">
          <ConversationTimeline
            messages={ticket.messages}
            activities={ticket.activities}
            includeInternal={props.canSeeInternal}
            currentUserId={props.currentUserId}
            userMap={props.userMap}
            statusMap={props.statusMap}
            priorityMap={props.priorityMap}
            platformStaffIds={staffSet}
          />
          {ticket.status === 'RESOLVED' && ticket.createdByUserId === props.currentUserId && ticket.satisfactionRating === null && (
            <div className="mt-4"><CsatPrompt ticketId={ticket.id} /></div>
          )}
        </div>
        <div className="border-t p-3">
          <div className="mb-2 flex gap-2 text-xs">
            <button onClick={() => setReplyMode('reply')} className={`rounded px-2 py-1 ${replyMode === 'reply' ? 'bg-accent' : 'text-muted-foreground hover:bg-accent/50'}`}>Yanit</button>
            {props.canManage && (
              <button onClick={() => setReplyMode('internal')} className={`rounded px-2 py-1 ${replyMode === 'internal' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'text-muted-foreground hover:bg-accent/50'}`}>Internal note</button>
            )}
          </div>
          <ReplyComposer
            allowInternalToggle={props.canManage}
            defaultInternal={replyMode === 'internal'}
            isPending={send.isPending}
            onSend={handleSend}
          />
        </div>
      </div>
      <ConversationSidebar
        ticket={ticket}
        canManage={props.canManage}
        statusValues={props.statusValues}
        priorityValues={props.priorityValues}
        categoryValues={props.categoryValues}
        members={props.members}
        tags={ticket.tags.map((tt: any) => tt.tag)}
        availableTags={props.availableTags}
        customerName={props.customerName}
        customerEmail={props.customerEmail}
        tenantName={props.tenantName}
        tenantSlug={props.tenantSlug}
        tenantPlan={props.tenantPlan}
        onStatusChange={(v) => handleUpdate({ status: v })}
        onPriorityChange={(v) => handleUpdate({ priority: v })}
        onCategoryChange={(v) => handleUpdate({ category: v })}
        onAssigneeChange={(v) => handleUpdate({ assignedToUserId: v })}
        onTagAdd={handleAddTag}
        onTagRemove={handleRemoveTag}
      />
    </div>
  )
}
