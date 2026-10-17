'use client'

import { useState } from 'react'
import { SendIcon } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Checkbox } from '@/shared/components/ui/checkbox'
import { Textarea } from '@/shared/components/ui/textarea'
import { Avatar, AvatarFallback } from '@/shared/components/ui/avatar'
import { useAction } from '@/shared/hooks/use-action'
import { sendMessage } from '../actions/send-message'

interface MessageItem {
  id: string
  senderUserId: string
  content: string | null
  isInternal: boolean
  createdAt: string
}

interface MessageThreadProps {
  ticketId: string
  messages: MessageItem[]
  currentUserId: string
  canManage: boolean
  userMap: Record<string, string>
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export function MessageThread({
  ticketId,
  messages,
  currentUserId,
  canManage,
  userMap,
}: MessageThreadProps) {
  const [content, setContent] = useState('')
  const [isInternal, setIsInternal] = useState(false)

  const { execute, isPending } = useAction(sendMessage, {
    successMessage: 'Message sent',
    onSuccess: () => {
      setContent('')
      setIsInternal(false)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!content.trim()) return

    execute({
      ticketId,
      bodyRich: content.trim(),
      bodyPlain: content.trim(),
      isInternal,
    })
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Messages</h3>

      {/* Message list */}
      <div className="space-y-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No messages yet. Start the conversation below.
          </p>
        ) : (
          messages.map((msg) => {
            const senderName = userMap[msg.senderUserId] ?? 'Unknown'
            const isOwn = msg.senderUserId === currentUserId

            return (
              <div
                key={msg.id}
                className={`flex gap-3 ${isOwn ? 'flex-row-reverse' : ''}`}
              >
                <Avatar size="sm">
                  <AvatarFallback>{getInitials(senderName)}</AvatarFallback>
                </Avatar>
                <div
                  className={`max-w-[70%] space-y-1 ${isOwn ? 'items-end text-right' : ''}`}
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium">{senderName}</span>
                    <span>{new Date(msg.createdAt).toLocaleString()}</span>
                    {msg.isInternal && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                        Internal note
                      </span>
                    )}
                  </div>
                  <div
                    className={`rounded-lg px-3 py-2 text-sm ${
                      msg.isInternal
                        ? 'bg-amber-500/5 border-l-2 border-amber-500'
                        : isOwn
                          ? 'bg-primary/5'
                          : 'bg-card border border-border'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Reply form */}
      <form onSubmit={handleSubmit} className="space-y-3 border-t pt-4">
        <Textarea
          placeholder="Type your message..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-20"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {canManage && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={isInternal}
                  onCheckedChange={(checked) => setIsInternal(!!checked)}
                />
                <span className="text-muted-foreground">Internal note</span>
              </label>
            )}
          </div>
          <Button type="submit" disabled={isPending || !content.trim()}>
            <SendIcon className="size-4" />
            {isPending ? 'Sending...' : 'Send'}
          </Button>
        </div>
      </form>
    </div>
  )
}
