import { NextResponse } from 'next/server'
import { requireAuth } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { getStorage } from '@/shared/lib/storage'

export const runtime = 'nodejs'

/**
 * Pre-save preview endpoint for images that have been uploaded but not yet
 * attached to a persisted message (pasted/dropped in the reply composer).
 * Serves the raw blob by its storageKey with tenant-scoped authorization.
 *
 * Authorization:
 *   - "support/<tenantId>/...": caller must be in that tenant OR platform staff.
 *   - "support/internal/...": caller must be platform staff.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const user = await requireAuth()
  const { key } = await params
  const storageKey = key.join('/')

  const match = /^support\/([^/]+)\//.exec(storageKey)
  if (!match) {
    return NextResponse.json({ error: 'invalid-key' }, { status: 400 })
  }
  const tenantPart = match[1]

  const isPlatformStaff = user.permissions.includes(PERMISSIONS.TICKET_MANAGE)
  if (tenantPart === 'internal') {
    if (!isPlatformStaff) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else if (tenantPart !== user.currentTenantId && !isPlatformStaff) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    const buffer = await getStorage().download(storageKey)
    const mime = detectImageMime(buffer) ?? 'application/octet-stream'
    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return NextResponse.json({ error: 'not-found' }, { status: 404 })
  }
}

function detectImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return 'image/gif'
  }
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}
