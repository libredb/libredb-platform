'use server'

import { revalidatePath } from 'next/cache'
import { safeAction } from '@/shared/lib/safe-action'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { ValidationError } from '@/shared/lib/errors'
import { getLicenseStatus } from '@/shared/lib/license/install-license'
import { canonicalDefinition } from '@/shared/lib/sealing/jcs'
import { parseEngineFields, updateDatabaseConnectionSchema } from '../lib/database-connection.schema'
import {
  DatabaseConnectionRepository,
  type DatabaseConnectionChanges,
  type ResealedLevel,
} from '../lib/database-connection.repository'
import { requireSealKey, sealCredential } from '../lib/credential-sealing'

const METADATA = ['name', 'environment', 'groupName', 'color', 'mcpEnabled', 'active'] as const

/**
 * Changes a connection of the session tenant; any other id answers NotFound. Name, environment, group, color, the MCP
 * flag and `active` change freely. Each envelope is bound to the id, engine and definition, so a changed
 * engine or definition needs the read credential again and, when a write credential exists, a new one or its removal,
 * refused here with field errors before the rebind trigger of the database would refuse the update.
 * A credential given without such a change is sealed again for the stored engine and definition.
 * In self-hosted mode, though, the license of the install may refuse turning a connection active again, which publishes
 * its grants to Studio again.
 */
export const updateDatabaseConnection = safeAction(
  'updateDatabaseConnection',
  updateDatabaseConnectionSchema,
  async (input, user) => {
    await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No active tenant')

    const current = await DatabaseConnectionRepository.findById(tenantId, input.id)

    const engine = input.engine ?? current.engine
    const engineChanged = engine !== current.engine
    const touchesEngineFields =
      engineChanged ||
      input.definition !== undefined ||
      input.readCredential !== undefined ||
      input.writeCredential !== undefined
    // A new engine is checked against the stored definition unless a new definition comes with it.
    const fields = touchesEngineFields
      ? parseEngineFields(engine, {
          definition: input.definition ?? (engineChanged ? current.definition : undefined),
          readCredential: input.readCredential,
          writeCredential: input.writeCredential,
        })
      : {}
    const definition = fields.definition ?? current.definition
    // The stored definition sent again, in any key order, is no change.
    const rebinds =
      engineChanged ||
      (fields.definition !== undefined && canonicalDefinition(fields.definition) !== canonicalDefinition(current.definition))

    if (rebinds) {
      const fieldErrors: Record<string, string[]> = {}
      if (fields.readCredential === undefined) {
        fieldErrors.readCredential = ['A changed engine or definition needs the read credential again']
      }
      if (current.hasWriteCredential && fields.writeCredential === undefined && input.removeWriteCredential !== true) {
        fieldErrors.writeCredential = ['A changed engine or definition needs the write credential again, or its removal']
      }
      if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors)
    }

    const changes: DatabaseConnectionChanges = {}
    for (const field of METADATA) {
      const value = input[field]
      if (value !== undefined && value !== current[field]) Object.assign(changes, { [field]: value })
    }

    const resealed: ResealedLevel[] = []
    if (fields.readCredential !== undefined || fields.writeCredential !== undefined) {
      const key = requireSealKey()
      const binding = { connectionId: current.id, engine, definition }
      // The binding is written with the envelopes sealed for it.
      changes.engine = engine
      changes.definition = definition
      if (fields.readCredential !== undefined) {
        changes.readSecret = sealCredential(key, binding, 'read', fields.readCredential)
        resealed.push('read')
      }
      if (fields.writeCredential !== undefined) {
        changes.writeSecret = sealCredential(key, binding, 'write', fields.writeCredential)
        resealed.push('write')
      }
    }
    if (input.removeWriteCredential === true && current.hasWriteCredential) {
      changes.writeSecret = null
    }

    if (Object.keys(changes).length > 0) {
      await DatabaseConnectionRepository.update(tenantId, current.id, user.id, 'web', changes, resealed, getLicenseStatus())
      revalidatePath('/connections')
      revalidatePath(`/connections/${current.id}`)
    }
    return { id: current.id }
  },
)
