import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { SupportRepository } from '@/features/support/lib/support.repository'
import { TicketForm } from '@/features/support/components/ticket-form'

export default async function NewTicketPage() {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.TICKET_CREATE)
  const [priorityValues, categoryValues] = await Promise.all([
    SupportRepository.getReferenceValues('TICKET_PRIORITY'),
    SupportRepository.getReferenceValues('TICKET_CATEGORY'),
  ])
  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="mb-4 text-xl font-semibold">New Ticket</h1>
      <TicketForm priorityValues={priorityValues} categoryValues={categoryValues} />
    </div>
  )
}
