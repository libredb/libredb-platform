'use client'

import { useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Mention from '@tiptap/extension-mention'
import { mentionSuggestion } from '../hooks/use-mentions'
import { common, createLowlight } from 'lowlight'
import { Button } from '@/shared/components/ui/button'
import { Checkbox } from '@/shared/components/ui/checkbox'
import { useAttachmentUpload, type AttachmentMeta } from '@/features/support/hooks/use-attachment-upload'
import { AttachmentTile } from './attachment-tile'
import {
  BoldIcon, ItalicIcon, LinkIcon, CodeIcon, ListIcon, ListOrderedIcon,
  PaperclipIcon, SendIcon, LockIcon,
} from 'lucide-react'

const lowlight = createLowlight(common)

interface ReplyComposerProps {
  placeholder?: string
  allowInternalToggle: boolean
  onSend: (payload: {
    bodyRich: string
    bodyPlain: string
    isInternal: boolean
    attachments: AttachmentMeta[]
  }) => Promise<void> | void
  defaultInternal?: boolean
  isPending?: boolean
}

export function ReplyComposer({
  placeholder = 'Write a reply... (⌘⏎ to send)',
  allowInternalToggle,
  onSend,
  defaultInternal = false,
  isPending = false,
}: ReplyComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { entries, upload, remove, reset, successfulMetas } = useAttachmentUpload()

  const editor = useEditor({
    immediatelyRender: false,
    // TipTap 3 does not re-render on editor transactions by default, and this render reads the editor's text for the
    // send button and its active marks for the toolbar.
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: false,
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Placeholder.configure({ placeholder }),
      Image,
      CodeBlockLowlight.configure({ lowlight }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Mention.configure({
        HTMLAttributes: { class: 'mention-chip' },
        suggestion: mentionSuggestion as any,
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        renderHTML: ({ options, node }) => [
          'span',
          {
            ...options.HTMLAttributes,
            'data-mention-id': node.attrs.id,
            'data-mention-label': node.attrs.label,
          },
          `@${node.attrs.label ?? node.attrs.id}`,
        ],
      }),
    ],
    content: '',
    editorProps: {
      attributes: { class: 'tiptap-prose' },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length === 0) return false
        event.preventDefault()
        void (async () => {
          const metas = await upload(files)
          for (const m of metas) {
            if (m.mimeType.startsWith('image/')) {
              editor?.chain().focus().setImage({ src: `/support/api/attachments/tmp/${m.storageKey}` }).run()
            }
          }
        })()
        return true
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? [])
        if (files.length === 0) return false
        event.preventDefault()
        void upload(files)
        return true
      },
    },
  })

  const handleSend = useCallback(async () => {
    if (!editor) return
    const html = editor.getHTML()
    const plain = editor.getText().trim()
    if (!plain && successfulMetas.length === 0) return

    await onSend({
      bodyRich: html,
      bodyPlain: plain,
      isInternal: defaultInternal,
      attachments: successfulMetas,
    })

    editor.commands.clearContent()
    reset()
  }, [editor, onSend, defaultInternal, successfulMetas, reset])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSend()
    }
  }, [handleSend])

  if (!editor) return <div className="h-32 animate-pulse rounded-md bg-muted" />

  const hasContent = editor.getText().trim().length > 0 || successfulMetas.length > 0

  return (
    <div className="space-y-2" onKeyDown={handleKeyDown}>
      <div className="flex items-center gap-1 border-b pb-2">
        <ToolbarButton active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} icon={<BoldIcon className="size-4" />} label="Bold" />
        <ToolbarButton active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} icon={<ItalicIcon className="size-4" />} label="Italic" />
        <ToolbarButton active={editor.isActive('link')} onClick={() => {
          const url = prompt('URL:')
          if (url) editor.chain().focus().setLink({ href: url }).run()
        }} icon={<LinkIcon className="size-4" />} label="Link" />
        <div className="mx-1 h-5 w-px bg-border" />
        <ToolbarButton active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} icon={<ListIcon className="size-4" />} label="Bullet list" />
        <ToolbarButton active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} icon={<ListOrderedIcon className="size-4" />} label="Ordered list" />
        <ToolbarButton active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} icon={<CodeIcon className="size-4" />} label="Code" />
        <div className="mx-1 h-5 w-px bg-border" />
        <ToolbarButton onClick={() => fileInputRef.current?.click()} icon={<PaperclipIcon className="size-4" />} label="Attach" />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => { if (e.target.files) void upload(Array.from(e.target.files)) }}
        />
      </div>

      <div className="tiptap-editor">
        <EditorContent editor={editor} />
      </div>

      {entries.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {entries.map(e => (
            <AttachmentTile
              key={e.localId}
              fileName={e.file.name}
              mimeType={e.file.type}
              progress={e.progress}
              error={e.error}
              onRemove={() => remove(e.localId)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {allowInternalToggle && (
            <label className="flex items-center gap-2">
              <Checkbox checked={defaultInternal} disabled />
              <span className="flex items-center gap-1"><LockIcon className="size-3" /> Internal note</span>
            </label>
          )}
          <span>Ctrl+Enter to send</span>
        </div>
        <Button onClick={() => void handleSend()} disabled={!hasContent || isPending}>
          <SendIcon className="size-4" />
          {isPending ? 'Sending...' : 'Send'}
        </Button>
      </div>
    </div>
  )
}

function ToolbarButton({
  active, onClick, icon, label,
}: { active?: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded p-1.5 transition-colors ${active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}`}
    >
      {icon}
    </button>
  )
}
