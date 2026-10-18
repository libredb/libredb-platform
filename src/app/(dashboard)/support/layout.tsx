import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { SupportRepository } from '@/features/support/lib/support.repository'
import { InboxLayout } from '@/features/support/components/inbox-layout'
import { ShortcutsHelp } from '@/features/support/components/shortcuts-help'
import { InboxSidebar } from '@/features/support/components/inbox-sidebar'
import { InboxList } from '@/features/support/components/inbox-list'

export default async function SupportLayout({
  children, modal,
}: { children: React.ReactNode; modal: React.ReactNode }) {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.TICKET_VIEW)
  const [availableTags, priorityValues] = await Promise.all([
    SupportRepository.listAccessibleTags(user.currentTenantId ?? null),
    SupportRepository.getReferenceValues('TICKET_PRIORITY'),
  ])
  return (
    <>
      <InboxLayout
        sidebar={<InboxSidebar availableTags={availableTags.map(t => ({ id: t.id, name: t.name, colorCode: t.colorCode }))} />}
        list={<InboxList priorityValues={priorityValues.map(p => ({ code: p.code, name: p.name }))} />}
        detail={children}
      />
      {modal}
      <ShortcutsHelp />
    </>
  )
}
