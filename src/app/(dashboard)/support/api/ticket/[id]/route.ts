import { NextResponse } from 'next/server'
import { requireAuth } from '@/shared/lib/auth-utils'
import { SupportRepository } from '@/features/support/lib/support.repository'
import { canViewTicket, canSeeInternalNotes } from '@/features/support/lib/support-permissions'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth()
  const { id } = await params
  const ticket = await SupportRepository.findById(id).catch(() => null)
  if (!ticket) return NextResponse.json({ error: 'not-found' }, { status: 404 })
  if (!canViewTicket(user, ticket)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const hideInternal = !canSeeInternalNotes(user)
  return NextResponse.json({
    ...ticket,
    messages: hideInternal ? ticket.messages.filter((m: any) => !m.isInternal) : ticket.messages,
  })
}
