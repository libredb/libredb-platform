'use client'

import { useState } from 'react'
import { Dialog, DialogContent } from '@/shared/components/ui/dialog'

interface AttachmentImageProps {
  attachmentId: string
  fileName: string
  thumbUrl: string
  fullUrl: string
}

export function AttachmentImage({ fileName, thumbUrl, fullUrl }: AttachmentImageProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="overflow-hidden rounded-md border border-border hover:opacity-90"
      >
        <img src={thumbUrl} alt={fileName} className="max-h-[160px] w-auto" />
      </button>
      <Dialog open={open} onOpenChange={(value) => setOpen(value)}>
        <DialogContent className="max-w-5xl">
          <img src={fullUrl} alt={fileName} className="max-h-[80vh] w-auto rounded-md" />
          <div className="text-center text-xs text-muted-foreground">{fileName}</div>
          <a href={fullUrl} download={fileName} className="text-center text-xs underline">İndir</a>
        </DialogContent>
      </Dialog>
    </>
  )
}
