import { z } from 'zod'
import { apiError, apiSuccess, getApiUser } from '@/shared/lib/api-utils'
import { queryEventFiltersSchema } from '@/shared/lib/bridge/query-events'
import { hasFeature } from '@/shared/lib/feature-flags'
import { AuditRepository } from '@/features/audit/lib/audit.repository'

// The filters a caller may pass. The tenant is never one of them: it comes from the session only.
const FILTER_PARAMS = ['subject', 'connectionId', 'source', 'statementType', 'status', 'from', 'to', 'search', 'limit', 'offset'] as const

export async function GET(request: Request) {
  const user = await getApiUser()
  if (!user) return apiError('Unauthorized', 401)
  if (!user.currentTenantId) return apiError('No tenant selected', 400)

  // The plan of the tenant gates the audit log before the permission, PLATFORM_ADMIN included, as the audit page does.
  if (!(await hasFeature(user.currentTenantId, 'auditLog'))) {
    return apiError('This feature requires a plan upgrade', 403)
  }

  // Require audit.view permission
  const isPlatformAdmin = user.roles.includes('PLATFORM_ADMIN')
  const hasPermission = isPlatformAdmin || user.permissions.includes('audit.view')
  if (!hasPermission) {
    return apiError('Permission denied: audit.view required', 403)
  }

  const { searchParams } = new URL(request.url)
  const params: Record<string, string> = {}
  for (const name of FILTER_PARAMS) {
    const value = searchParams.get(name)
    if (value) params[name] = value
  }

  const parsed = queryEventFiltersSchema.safeParse({ ...params, tenantId: user.currentTenantId })
  if (!parsed.success) {
    const fields = Object.keys(z.flattenError(parsed.error).fieldErrors).join(', ')
    return apiError(`Invalid audit filters: ${fields}`, 400)
  }

  const { events, total } = await AuditRepository.findAll(parsed.data)

  return apiSuccess({ events, total })
}
