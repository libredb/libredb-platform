'use client'

import { Avatar, AvatarFallback } from '@/shared/components/ui/avatar'
import { Badge } from '@/shared/components/ui/badge'
import { LockIcon, PencilIcon, FileIcon } from 'lucide-react'
import { AttachmentImage } from './attachment-image'
import { SanitizedHtml } from './sanitized-html'
import { format } from 'date-fns'

export interface TimelineMessageProps {
  message: {
    id: string
    senderUserId: string
    bodyRich: string | null
    bodyPlain: string | null
    isInternal: boolean
    editedAt: Date | string | null
    createdAt: Date | string
    attachments: Array<{
      id: string
      fileName: string
      fileSize: number
      mimeType: string
      width: number | null
      height: number | null
      thumbnailKey: string | null
    }>
  }
  senderName: string
  senderRole: 'customer' | 'agent' | 'system'
  isOwn: boolean
  canEdit: boolean
  onEditRequest?: () => void
}

function initials(name: string): string {
  return name.split(/\s+/).map(p => p[0]).join('').toUpperCase().slice(0, 2)
}

export function TimelineMessage({
  message, senderName, senderRole, canEdit, onEditRequest,
}: TimelineMessageProps) {
  const dotColor =
    senderRole === 'customer' ? 'border-amber-500'
    : senderRole === 'agent' ? 'border-blue-500'
    : 'border-muted-foreground'
  const avatarColor =
    senderRole === 'customer' ? 'bg-amber-500'
    : senderRole === 'agent' ? 'bg-blue-500'
    : 'bg-muted'
  const msgClass = message.isInternal
    ? 'border-l-2 border-amber-500 bg-amber-500/5'
    : senderRole === 'agent'
    ? 'bg-accent'
    : 'bg-card border border-border'

  return (
    <div className="relative pl-8">
      <span
        aria-hidden
        className={`absolute left-[5px] top-3 size-[11px] rounded-full border-2 bg-background ${dotColor}`}
      />
      <div className={`group rounded-md p-3 ${msgClass}`}>
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <Avatar className={`size-5 ${avatarColor} text-[10px]`}>
            <AvatarFallback>{initials(senderName)}</AvatarFallback>
          </Avatar>
          <span className="font-medium text-foreground">{senderName}</span>
          {message.isInternal && (
            <Badge variant="outline" className="h-4 gap-1 px-1 text-[10px]">
              <LockIcon className="size-2.5" /> Internal
            </Badge>
          )}
          <span>·</span>
          <time>{format(new Date(message.createdAt), 'HH:mm · d MMM')}</time>
          {message.editedAt && <span className="italic">(edited)</span>}
          {canEdit && onEditRequest && (
            <button
              type="button"
              onClick={onEditRequest}
              className="ml-auto hidden rounded p-1 hover:bg-accent group-hover:inline-flex"
              title="Edit"
            >
              <PencilIcon className="size-3" />
            </button>
          )}
        </div>
        {message.bodyRich ? (
          <SanitizedHtml html={message.bodyRich} className="tiptap-prose text-sm" />
        ) : (
          <div className="whitespace-pre-wrap text-sm">{message.bodyPlain}</div>
        )}
        {message.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.attachments.map(a => {
              const url = `/support/api/attachments/${a.id}/download`
              if (a.mimeType.startsWith('image/') && a.thumbnailKey) {
                return (
                  <AttachmentImage
                    key={a.id}
                    attachmentId={a.id}
                    fileName={a.fileName}
                    thumbUrl={url}
                    fullUrl={url}
                  />
                )
              }
              return (
                <a
                  key={a.id}
                  href={url}
                  download={a.fileName}
                  className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
                >
                  <FileIcon className="size-3" />
                  {a.fileName}
                  <span className="text-muted-foreground">({Math.round(a.fileSize / 1024)} KB)</span>
                </a>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
