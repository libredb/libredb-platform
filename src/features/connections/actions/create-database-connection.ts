'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { safeAction } from '@/shared/lib/safe-action'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { checkLimit, getLimit } from '@/shared/lib/feature-flags'
import { LimitExceededError } from '@/shared/lib/errors'
import { getLicenseStatus } from '@/shared/lib/license/install-license'
import { createDatabaseConnectionSchema } from '../lib/database-connection.schema'
import { DatabaseConnectionRepository } from '../lib/database-connection.repository'
import { requireSealKey, sealCredential } from '../lib/credential-sealing'

/**
 * Creates a connection Studio serves through bridge.connections_v1. The id is generated before
 * sealing, because the AAD of each envelope binds it with the engine and the definition, and the row and its
 * admin action are written in one transaction. The creator gets no grant: access to a connection comes from grants
 * alone. In self-hosted mode the license of the install refuses a new connection when it could not be verified or has
 * expired, and while more user seats are in use than it allows. Returns the id only, never an envelope.
 */
export const createDatabaseConnection = safeAction(
  'createDatabaseConnection',
  createDatabaseConnectionSchema,
  async (input, user) => {
    await requirePermission(user, PERMISSIONS.CONNECTION_CREATE)

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No active tenant')

    const key = requireSealKey()

    const count = await DatabaseConnectionRepository.countByTenant(tenantId)
    if (!(await checkLimit(tenantId, 'maxConnections', count))) {
      throw new LimitExceededError('connections', await getLimit(tenantId, 'maxConnections'))
    }

    const id = randomUUID()
    const binding = { connectionId: id, engine: input.engine, definition: input.definition }
    const created = await DatabaseConnectionRepository.create(
      tenantId,
      user.id,
      {
        id,
        name: input.name,
        engine: input.engine,
        environment: input.environment ?? null,
        groupName: input.groupName ?? null,
        color: input.color ?? null,
        mcpEnabled: input.mcpEnabled ?? false,
        definition: input.definition,
        readSecret: sealCredential(key, binding, 'read', input.readCredential),
        writeSecret:
          input.writeCredential === undefined ? null : sealCredential(key, binding, 'write', input.writeCredential),
      },
      getLicenseStatus(),
    )

    revalidatePath('/connections')
    return { id: created.id }
  },
)
