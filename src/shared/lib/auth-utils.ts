import { auth } from './auth'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { ForbiddenError, UnauthorizedError } from './errors'
import type { CurrentUser } from '../types'

export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  const session = await auth()
  if (!session?.user) throw new UnauthorizedError()

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
})

export async function requireAuth(): Promise<CurrentUser> {
  try {
    return await getCurrentUser()
  } catch {
    redirect('/login')
  }
}

export async function requirePermission(user: CurrentUser, permission: string): Promise<void> {
  const isPlatformAdmin = user.roles.includes('PLATFORM_ADMIN')
  if (isPlatformAdmin) return
  if (!user.permissions.includes(permission)) {
    throw new ForbiddenError(permission)
  }
}

export async function requireRole(user: CurrentUser, ...roles: string[]): Promise<void> {
  const hasRole = user.roles.some(r => roles.includes(r))
  if (!hasRole) {
    throw new ForbiddenError()
  }
}
