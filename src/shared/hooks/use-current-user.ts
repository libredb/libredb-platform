'use client'

import { useSession } from 'next-auth/react'
import type { CurrentUser } from '@/shared/types'

export function useCurrentUser(): CurrentUser | null {
  const { data: session } = useSession()
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
