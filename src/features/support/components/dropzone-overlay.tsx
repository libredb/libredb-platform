'use client'

import { useEffect, useState } from 'react'
import { UploadCloudIcon } from 'lucide-react'

interface DropzoneOverlayProps {
  containerRef: React.RefObject<HTMLElement | null>
  onFiles: (files: File[]) => void
}

export function DropzoneOverlay({ containerRef, onFiles }: DropzoneOverlayProps) {
  const [active, setActive] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let counter = 0
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      counter++
      setActive(true)
    }
    const leave = () => {
      counter = Math.max(0, counter - 1)
      if (counter === 0) setActive(false)
    }
    const over = (e: DragEvent) => { e.preventDefault() }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      counter = 0
      setActive(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length > 0) onFiles(files)
    }

    el.addEventListener('dragenter', enter)
    el.addEventListener('dragleave', leave)
    el.addEventListener('dragover', over)
    el.addEventListener('drop', drop)

    return () => {
      el.removeEventListener('dragenter', enter)
      el.removeEventListener('dragleave', leave)
      el.removeEventListener('dragover', over)
      el.removeEventListener('drop', drop)
    }
  }, [containerRef, onFiles])

  if (!active) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-background/85 backdrop-blur-sm ring-2 ring-primary ring-offset-2 ring-offset-background">
      <div className="flex flex-col items-center gap-2 text-primary">
        <UploadCloudIcon className="size-8" />
        <span className="text-sm font-medium">Drop files here</span>
      </div>
    </div>
  )
}
