import { z } from 'zod'
import type { CurrentUser } from '@/shared/types'
import { queryEventFiltersSchema } from '@/shared/lib/bridge/query-events'
import { PermissionDeniedError, PlanFeatureRequiredError, ValidationError } from '@/shared/lib/errors'
import { hasFeature } from '@/shared/lib/feature-flags'
import { PERMISSIONS, SYSTEM_ROLES } from '@/shared/lib/permissions'
import { AuditRepository } from './audit.repository'

// The filters a caller may pass. The tenant is never one of them: it comes from the user only.
const FILTER_PARAMS = ['subject', 'connectionId', 'source', 'statementType', 'status', 'from', 'to', 'search', 'limit', 'offset'] as const

/**
 * The query events of the user's tenant that the filters of a query string select, for GET /api/db/audit and
 * GET /api/v1/audit, so the two cannot drift.
 * The plan of the tenant gates the audit log before the permission, PLATFORM_ADMIN included, as the audit page does.
 * Throws PlanFeatureRequiredError, PermissionDeniedError, and ValidationError naming every invalid filter.
 */
export async function readAuditEvents(user: CurrentUser & { currentTenantId: string }, searchParams: URLSearchParams) {
  if (!(await hasFeature(user.currentTenantId, 'auditLog'))) throw new PlanFeatureRequiredError()

  const hasPermission = user.roles.includes(SYSTEM_ROLES.PLATFORM_ADMIN) || user.permissions.includes(PERMISSIONS.AUDIT_VIEW)
  if (!hasPermission) throw new PermissionDeniedError(PERMISSIONS.AUDIT_VIEW)

  const params: Record<string, string> = {}
  for (const name of FILTER_PARAMS) {
    const value = searchParams.get(name)
    if (value) params[name] = value
  }

  const parsed = queryEventFiltersSchema.safeParse({ ...params, tenantId: user.currentTenantId })
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors as Record<string, string[]>
    throw new ValidationError(fieldErrors, `Invalid audit filters: ${Object.keys(fieldErrors).join(', ')}`)
  }

  const { events, total } = await AuditRepository.findAll(parsed.data)
  return { events, total }
}
