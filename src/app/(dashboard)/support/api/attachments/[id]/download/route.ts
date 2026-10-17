import { NextResponse } from 'next/server'
import { requireAuth } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { db } from '@/shared/lib/db'
import { getStorage } from '@/shared/lib/storage'
import { canViewTicket } from '@/features/support/lib/support-permissions'

export const runtime = 'nodejs'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireAuth()
  const { id } = await params

  const attachment = await db.supportAttachment.findUnique({
    where: { id },
    include: {
      message: {
        include: {
          ticket: {
            select: {
              tenantId: true,
              createdByUserId: true,
              assignedToUserId: true,
            },
          },
        },
      },
    },
  })

  if (!attachment) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 })
  }

  // Hide internal-note attachments from non-platform users
  if (attachment.message.isInternal) {
    const canSeeInternal = user.permissions.includes(PERMISSIONS.TICKET_VIEW_ALL)
    if (!canSeeInternal) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  if (!canViewTicket(user, attachment.message.ticket)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const storage = getStorage()
  try {
    const url = await storage.getSignedUrl(attachment.storageKey, 900) // 15 minutes

    // Only redirect for absolute URLs (S3 presigned URLs)
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return NextResponse.redirect(url, 302)
    }

    // Local provider returns relative paths: fall through to stream
    throw new Error('relative-url')
  } catch {
    // Local provider or S3 presigning failed: stream via download()
    const buffer = await storage.download(attachment.storageKey)
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': attachment.mimeType,
        'Content-Disposition': `inline; filename="${attachment.fileName}"`,
        'Cache-Control': 'private, max-age=0',
      },
    })
  }
}
