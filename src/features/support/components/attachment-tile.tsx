'use client'

import { XIcon, FileIcon, ImageIcon, AlertCircleIcon } from 'lucide-react'

interface AttachmentTileProps {
  fileName: string
  mimeType: string
  progress: number
  error?: string
  onRemove?: () => void
}

export function AttachmentTile({ fileName, mimeType, progress, error, onRemove }: AttachmentTileProps) {
  const Icon = mimeType.startsWith('image/') ? ImageIcon : FileIcon
  const pct = Math.round(progress * 100)
  return (
    <div className="relative flex min-w-[180px] items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
      {error
        ? <AlertCircleIcon className="size-4 text-destructive" />
        : <Icon className="size-4 text-muted-foreground" />}
      <span className="max-w-[120px] truncate" title={fileName}>{fileName}</span>
      {!error && pct < 100 && <span className="text-muted-foreground">{pct}%</span>}
      {error && <span className="text-destructive">{error}</span>}
      {onRemove && (
        <button type="button" onClick={onRemove} className="ml-auto rounded p-0.5 hover:bg-accent">
          <XIcon className="size-3" />
        </button>
      )}
      {!error && pct < 100 && (
        <div className="absolute inset-x-0 bottom-0 h-[2px] bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
