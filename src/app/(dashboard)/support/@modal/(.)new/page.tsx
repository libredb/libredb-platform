import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { TicketFormModal } from '@/features/support/components/ticket-form-modal'

export default async function NewTicketModal() {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.TICKET_CREATE)
  return <TicketFormModal />
}
