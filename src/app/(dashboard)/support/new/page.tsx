import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { TicketForm } from '@/features/support/components/ticket-form'

export default async function NewTicketPage() {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.TICKET_CREATE)
  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="mb-4 text-xl font-semibold">Yeni Ticket</h1>
      <TicketForm />
    </div>
  )
}
