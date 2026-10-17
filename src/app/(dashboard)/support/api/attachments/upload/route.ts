import { NextResponse } from 'next/server'
import sharp from 'sharp'
import { randomUUID } from 'crypto'
import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { getStorage } from '@/shared/lib/storage'
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
  isAllowedMime,
  isAllowedExtension,
  isDeniedExtension,
} from '@/features/support/lib/attachment-allowlist'

export const runtime = 'nodejs'
export const maxDuration = 30

interface UploadResponse {
  storageKey: string
  thumbnailKey: string | null
  fileName: string
  fileSize: number
  mimeType: string
  width: number | null
  height: number | null
}

export async function POST(req: Request): Promise<NextResponse<UploadResponse | { error: string }>> {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.TICKET_CREATE)

  const formData = await req.formData()
  const file = formData.get('file')

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'no-file' }, { status: 400 })
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'too-large' }, { status: 413 })
  }
  if (isDeniedExtension(file.name)) {
    return NextResponse.json({ error: 'ext-denied' }, { status: 415 })
  }
  if (!isAllowedMime(file.type) || !isAllowedExtension(file.name)) {
    return NextResponse.json({ error: 'mime-or-ext-not-allowed' }, { status: 415 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const storage = getStorage()
  const safeName = file.name.replace(/[^\w.\-]/g, '_').slice(0, 80)
  const tenantPart = user.currentTenantId ?? 'internal'
  const storageKey = `support/${tenantPart}/${randomUUID()}-${safeName}`

  await storage.upload(storageKey, buffer, file.type)

  let thumbnailKey: string | null = null
  let width: number | null = null
  let height: number | null = null

  if (file.type.startsWith('image/')) {
    try {
      const meta = await sharp(buffer).metadata()
      width = meta.width ?? null
      height = meta.height ?? null

      const thumb = await sharp(buffer)
        .resize({ width: 400, height: 300, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()

      thumbnailKey = `${storageKey}.thumb.webp`
      await storage.upload(thumbnailKey, thumb, 'image/webp')
    } catch {
      thumbnailKey = null
    }
  }

  void MAX_FILES_PER_MESSAGE // per-message cap enforced at send time, by the send-message and create-ticket actions

  return NextResponse.json({
    storageKey,
    thumbnailKey,
    fileName: safeName,
    fileSize: file.size,
    mimeType: file.type,
    width,
    height,
  })
}
