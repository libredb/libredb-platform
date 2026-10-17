import { notFound } from 'next/navigation'
import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { NotFoundError } from '@/shared/lib/errors'
import { isSelfHosted } from '@/shared/lib/deployment'
import { DatabaseConnectionRepository } from '@/features/connections/lib/database-connection.repository'
import { requireSealKey } from '@/features/connections/lib/credential-sealing'
import { ENGINES, isEngineId } from '@/features/connections/lib/engines'
import { ConnectionForm } from '@/features/connections/components/connection-form'
import { ConnectionAccessPanel, loadConnectionAccess } from '@/features/connections'

export default async function ConnectionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.CONNECTION_VIEW)

  const tenantId = user.currentTenantId
  if (!tenantId) notFound()

  const { id } = await params
  // The repository reads within the session tenant, so the id of another tenant's connection answers 404.
  let connection
  try {
    connection = await DatabaseConnectionRepository.findById(tenantId, id)
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }

  // Envelopes sealed to an earlier Studio key open only while Studio still holds that key.
  const currentKid = requireSealKey().kid
  const staleLevels = [
    connection.readKid !== currentKid ? 'read' : null,
    connection.writeKid !== null && connection.writeKid !== currentKid ? 'write' : null,
  ].filter((level) => level !== null)

  const canEdit = user.permissions.includes(PERMISSIONS.CONNECTION_EDIT)
  // Grants name Keycloak users, so the access panel exists where Platform reads the Keycloak directory.
  const access = canEdit && isSelfHosted() ? await loadConnectionAccess(user, tenantId, connection) : null
  const engineLabel = isEngineId(connection.engine) ? ENGINES[connection.engine].label : connection.engine

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">
          {canEdit ? 'Edit Connection' : 'Connection Details'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {engineLabel} at <span className="font-mono">{connection.hostSummary}</span>
        </p>
      </div>

      {staleLevels.length > 0 && (
        <div role="alert" className="max-w-2xl rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          The {staleLevels.join(' and ')} credential{staleLevels.length > 1 ? 's are' : ' is'} sealed to an earlier Studio
          key ({[connection.readKid, connection.writeKid].filter((kid) => kid !== null && kid !== currentKid).join(', ')}),
          not the current key {currentKid}. Enter {staleLevels.length > 1 ? 'them' : 'it'} again before that key leaves
          Studio&apos;s keyring.
        </div>
      )}

      {canEdit ? (
        <ConnectionForm
          connection={{
            id: connection.id,
            name: connection.name,
            engine: connection.engine,
            environment: connection.environment,
            groupName: connection.groupName,
            definition: connection.definition,
            active: connection.active,
            hasWriteCredential: connection.hasWriteCredential,
          }}
        />
      ) : (
        <div className="max-w-lg space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="text-muted-foreground">Name</div>
            <div>{connection.name}</div>
            <div className="text-muted-foreground">Engine</div>
            <div>{engineLabel}</div>
            <div className="text-muted-foreground">Host</div>
            <div className="font-mono">{connection.hostSummary}</div>
            <div className="text-muted-foreground">Environment</div>
            <div>{connection.environment ?? 'None'}</div>
            <div className="text-muted-foreground">Group</div>
            <div>{connection.groupName ?? 'None'}</div>
            <div className="text-muted-foreground">Credentials</div>
            <div>{connection.hasWriteCredential ? 'Read and write' : 'Read only'}</div>
            <div className="text-muted-foreground">Status</div>
            <div>{connection.active ? 'Active' : 'Inactive'}</div>
          </div>
        </div>
      )}

      {access !== null && (
        <ConnectionAccessPanel
          connectionId={connection.id}
          hasWriteCredential={connection.hasWriteCredential}
          access={access}
        />
      )}
    </div>
  )
}
