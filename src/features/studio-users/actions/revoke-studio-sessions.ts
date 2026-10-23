'use server'

import { z } from 'zod'
import { db } from '@/shared/lib/db'
import { safeAction } from '@/shared/lib/safe-action'
import { requireRole } from '@/shared/lib/auth-utils'
import { isSelfHosted } from '@/shared/lib/deployment'
import { ForbiddenError } from '@/shared/lib/errors'
import { recordAdminAction } from '@/shared/lib/admin-actions'
import { insertSessionRevocation } from '@/shared/lib/governance/session-revocations'

// The target type of the admin actions that record a revocation.
const TARGET_TYPE = 'session_revocation'

const revokeStudioSessionsSchema = z.object({
  // The Keycloak user id, within the bounds that platform.session_revocations checks.
  subject: z.string().min(1).max(512),
})

/**
 * Ends every Studio session of a Keycloak user: inserts a revocation with reason admin
 * and its admin action in one transaction, and returns only the revocation id.
 * It reads nothing from the Keycloak directory, so it also works while the directory is degraded.
 */
export const revokeStudioSessions = safeAction(
  'revokeStudioSessions',
  revokeStudioSessionsSchema,
  async ({ subject }, user) => {
    // Only a self-hosted install has Studio sessions that read the revocations.
    if (!isSelfHosted()) {
      throw new ForbiddenError('not available in cloud mode')
    }
    await requireRole(user, 'PLATFORM_ADMIN')

    return db.$transaction(async (tx) => {
      const revocation = await insertSessionRevocation(tx, { subject, reason: 'admin', createdById: user.id })
      await recordAdminAction(tx, {
        actorId: user.id,
        channel: 'web',
        action: 'revocation.create',
        targetType: TARGET_TYPE,
        targetId: revocation.id,
        before: null,
        after: { subject, reason: 'admin', revokedBefore: revocation.revokedBefore.toISOString() },
      })
      return { id: revocation.id }
    })
  },
)
