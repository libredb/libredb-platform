import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { MessageSquareIcon } from 'lucide-react'

export default async function SupportIndexPage() {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.TICKET_VIEW)
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-sm space-y-3 text-center text-muted-foreground">
        <MessageSquareIcon className="mx-auto size-10 opacity-50" />
        <div className="text-sm">Soldaki listeden bir ticket seçin ya da üstten yeni ticket oluşturun.</div>
      </div>
    </div>
  )
}
