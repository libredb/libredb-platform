import { apiError, apiSuccess, getApiUser } from '@/shared/lib/api-utils'
import { AppError, ValidationError } from '@/shared/lib/errors'
import { readAuditEvents } from '@/features/audit/lib/audit-read'

export async function GET(request: Request) {
  const user = await getApiUser()
  if (!user) return apiError('Unauthorized', 401)
  if (!user.currentTenantId) return apiError('No tenant selected', 400)

  try {
    const { events, total } = await readAuditEvents(
      { ...user, currentTenantId: user.currentTenantId },
      new URL(request.url).searchParams,
    )
    return apiSuccess({ events, total })
  } catch (error) {
    if (error instanceof ValidationError) return apiError(error.message, 400)
    if (error instanceof AppError) return apiError(error.message, error.statusCode)
    throw error
  }
}
