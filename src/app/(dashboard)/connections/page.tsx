import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { getNewConnectionRefusal } from '@/shared/lib/license/install-license-notice'
import { DatabaseConnectionRepository } from '@/features/connections/lib/database-connection.repository'
import { ConnectionList } from '@/features/connections/components/connection-list'
import { PageHeader } from '@/shared/components/composed/page-header'

export default async function ConnectionsPage() {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.CONNECTION_VIEW)

  const tenantId = user.currentTenantId
  if (!tenantId) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Connections" description="Please select a tenant first." />
      </div>
    )
  }

  // Every connection of the session tenant, for each holder of connection.view: access to a connection in Studio
  // comes from grants, not from this list.
  const connections = await DatabaseConnectionRepository.findAllByTenant(tenantId)

  const canCreate = user.permissions.includes(PERMISSIONS.CONNECTION_CREATE)
  const canDelete = user.permissions.includes(PERMISSIONS.CONNECTION_DELETE)
  // The license of a self-hosted install may refuse a new connection, which the list shows on a disabled button.
  const createRefusal = canCreate ? await getNewConnectionRefusal() : null

  // Only what the list shows crosses to the client, never an envelope or its kid.
  const items = connections.map((c) => ({
    id: c.id,
    name: c.name,
    engine: c.engine,
    hostSummary: c.hostSummary,
    environment: c.environment,
    active: c.active,
    hasWriteCredential: c.hasWriteCredential,
    createdAt: c.createdAt.toISOString(),
  }))

  return (
    <div className="p-6 space-y-6">
      <ConnectionList connections={items} canCreate={canCreate} canDelete={canDelete} createRefusal={createRefusal} />
    </div>
  )
}
