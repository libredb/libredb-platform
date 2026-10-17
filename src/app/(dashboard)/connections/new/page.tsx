import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { ConnectionForm } from '@/features/connections/components/connection-form'

export default async function NewConnectionPage() {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.CONNECTION_CREATE)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New Connection</h1>
        <p className="text-sm text-muted-foreground">
          Add a database that Studio serves to the users you grant it to.
        </p>
      </div>
      <ConnectionForm />
    </div>
  )
}
