'use client'

import { useState } from 'react'
import { Button, buttonVariants } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Input } from '@/shared/components/ui/input'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { CheckIcon, MoreHorizontalIcon, RotateCcwIcon } from 'lucide-react'

interface ReferenceValue { code: string; name: string; colorCode: string | null }

interface ConversationHeaderProps {
  ticket: {
    id: string; ticketNumber: string; subject: string
    status: string; priority: string
    tenantName: string | null
    customerName: string
  }
  canManage: boolean
  statusValues: ReferenceValue[]
  priorityValues: ReferenceValue[]
  onResolve: () => void
  onReopen: () => void
  onUpdateSubject: (subject: string) => void
}

function colorStyle(code: string | null | undefined) {
  if (!code) return {}
  return { backgroundColor: `${code}20`, color: code, borderColor: `${code}40` }
}

export function ConversationHeader({
  ticket, canManage, statusValues, priorityValues,
  onResolve, onReopen, onUpdateSubject,
}: ConversationHeaderProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(ticket.subject)
  const status = statusValues.find(s => s.code === ticket.status)
  const priority = priorityValues.find(p => p.code === ticket.priority)
  const isResolved = ticket.status === 'RESOLVED' || ticket.status === 'CLOSED'

  const commit = () => {
    const t = draft.trim()
    if (t && t !== ticket.subject) onUpdateSubject(t)
    setEditing(false)
  }

  return (
    <header className="flex items-start justify-between gap-4 border-b bg-card px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{ticket.ticketNumber}</span>
          <span>·</span>
          <span>{ticket.tenantName ?? 'Internal'}</span>
          <span>·</span>
          <span>{ticket.customerName}</span>
          <Badge variant="outline" className="border text-[10px]" style={colorStyle(status?.colorCode)}>
            {status?.name ?? ticket.status}
          </Badge>
          <Badge variant="outline" className="border text-[10px]" style={colorStyle(priority?.colorCode)}>
            {priority?.name ?? ticket.priority}
          </Badge>
        </div>
        {editing && canManage ? (
          <Input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') { setDraft(ticket.subject); setEditing(false) }
            }}
            autoFocus
            className="text-lg font-semibold"
          />
        ) : (
          <h2
            onClick={() => canManage && setEditing(true)}
            className={`truncate text-lg font-semibold ${canManage ? 'cursor-text hover:bg-accent/30 rounded px-1 -mx-1' : ''}`}
            title={ticket.subject}
          >
            {ticket.subject}
          </h2>
        )}
      </div>
      {canManage && (
        <div className="flex items-center gap-2">
          {isResolved ? (
            <Button variant="outline" onClick={onReopen}>
              <RotateCcwIcon className="size-4" /> Reopen
            </Button>
          ) : (
            <Button onClick={onResolve}>
              <CheckIcon className="size-4" /> Resolve
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger className={buttonVariants({ variant: 'outline', size: 'icon' })}>
              <MoreHorizontalIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled>Merge (Phase 2)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </header>
  )
}
