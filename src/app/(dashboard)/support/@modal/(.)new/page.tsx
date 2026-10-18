import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { SupportRepository } from '@/features/support/lib/support.repository'
import { TicketFormModal } from '@/features/support/components/ticket-form-modal'

export default async function NewTicketModal() {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.TICKET_CREATE)
  const [priorityValues, categoryValues] = await Promise.all([
    SupportRepository.getReferenceValues('TICKET_PRIORITY'),
    SupportRepository.getReferenceValues('TICKET_CATEGORY'),
  ])
  return <TicketFormModal priorityValues={priorityValues} categoryValues={categoryValues} />
}
