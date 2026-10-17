'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import axios, { type AxiosProgressEvent } from 'axios'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
  isDeniedExtension,
} from '@/features/support/lib/attachment-allowlist'

export interface AttachmentMeta {
  storageKey: string
  thumbnailKey: string | null
  fileName: string
  fileSize: number
  mimeType: string
  width: number | null
  height: number | null
}

export interface UploadEntry {
  localId: string
  file: File
  progress: number         // 0..1
  meta?: AttachmentMeta
  error?: string
}

export function useAttachmentUpload() {
  const [entries, setEntries] = useState<UploadEntry[]>([])
  // Mirror `entries` into a ref so async callbacks can read the latest
  // value without stale closures. Direct `ref.current = entries` during
  // render trips the new `react-hooks/refs` rule, so we sync via effect.
  // There's a one-tick lag between a state update and the ref catching
  // up: acceptable here since the cap check only matters when a new
  // upload batch starts, long after any prior state update has flushed.
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  const upload = useCallback(async (files: File[]): Promise<AttachmentMeta[]> => {
    // Enforce the per-message file cap up front using a synchronous read
    // from the ref. Server-side `sendMessage` / `createTicket` validate the
    // same cap as a backstop: client checks are UX, not security.
    const successful = entriesRef.current.filter(e => !e.error).length
    const remaining = Math.max(0, MAX_FILES_PER_MESSAGE - successful)
    let filesToUpload = files
    if (files.length > remaining) {
      toast.error(`En fazla ${MAX_FILES_PER_MESSAGE} dosya ekleyebilirsin.`)
      filesToUpload = files.slice(0, remaining)
    }

    const results: AttachmentMeta[] = []

    for (const file of filesToUpload) {
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`${file.name}: 25 MB üzeri dosya kabul edilmiyor.`)
        continue
      }
      if (isDeniedExtension(file.name)) {
        toast.error(`${file.name}: bu uzantı güvenlik sebebiyle engellendi.`)
        continue
      }

      const localId = nanoid()
      setEntries(prev => [...prev, { localId, file, progress: 0 }])

      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await axios.post<AttachmentMeta>('/support/api/attachments/upload', fd, {
          onUploadProgress: (e: AxiosProgressEvent) => {
            const p = e.total ? e.loaded / e.total : 0
            setEntries(prev => prev.map(x => x.localId === localId ? { ...x, progress: p } : x))
          },
        })
        const meta = res.data
        setEntries(prev => prev.map(x => x.localId === localId ? { ...x, progress: 1, meta } : x))
        results.push(meta)
      } catch (err: unknown) {
        const msg = axios.isAxiosError(err)
          ? (err.response?.data?.error ?? err.message)
          : 'upload-failed'
        setEntries(prev => prev.map(x => x.localId === localId ? { ...x, error: String(msg) } : x))
        toast.error(`${file.name}: ${msg}`)
      }
    }

    return results
  }, [])

  const remove = useCallback((localId: string) => {
    setEntries(prev => prev.filter(e => e.localId !== localId))
  }, [])

  const reset = useCallback(() => setEntries([]), [])

  const successfulMetas = entries.filter(e => e.meta && !e.error).map(e => e.meta!) as AttachmentMeta[]

  return { entries, upload, remove, reset, successfulMetas }
}
