import { auth } from './auth'
import { NextResponse } from 'next/server'
import { logger } from './logger'
import { AppError } from './errors'
import type { CurrentUser } from '../types'

export function apiError(message: string, status: number = 500) {
  return NextResponse.json({ error: message }, { status })
}

export function apiSuccess<T>(data: T, status: number = 200) {
  return NextResponse.json(data, { status })
}

export async function getApiUser(): Promise<CurrentUser | null> {
  const session = await auth()
  if (!session?.user) return null

  return {
    id: session.user.id!,
    email: session.user.email!,
    name: session.user.name ?? null,
    authProvider: session.authProvider,
    currentTenantId: (session as any).currentTenantId,
    membershipId: (session as any).membershipId,
    roles: (session as any).roles ?? [],
    permissions: (session as any).permissions ?? [],
    accessibleTenants: (session as any).accessibleTenants ?? [],
    directoryDegraded: session.directoryDegraded,
  }
}

/**
 * Wrap an API route handler with standard auth + error handling.
 */
export function withApiAuth(
  handler: (user: CurrentUser, request: Request) => Promise<NextResponse>,
) {
  return async (request: Request) => {
    try {
      const user = await getApiUser()
      if (!user) {
        return apiError('Unauthorized', 401)
      }
      return await handler(user, request)
    } catch (error) {
      if (error instanceof AppError) {
        logger.warn('API error', { code: error.code, message: error.message })
        return apiError(error.message, error.statusCode)
      }
      logger.error('Unhandled API error', error instanceof Error ? error : new Error(String(error)))
      return apiError('Internal server error', 500)
    }
  }
}
