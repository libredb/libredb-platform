'use server'

import { db } from '@/shared/lib/db'
import { assertCloudOnly } from '@/shared/lib/deployment'
import { getCurrentUser } from '@/shared/lib/auth-utils'
import { logger } from '@/shared/lib/logger'
import { ForbiddenError } from '@/shared/lib/errors'
import { cookies } from 'next/headers'

export async function switchTenantAction(tenantId: string) {
  assertCloudOnly()
  const user = await getCurrentUser()

  // Verify membership
  const membership = await db.tenantMember.findFirst({
    where: { userId: user.id, tenantId, active: true },
  })

  if (!membership) {
    throw new ForbiddenError('Not a member of this tenant')
  }

  logger.info('Tenant switch', {
    userId: user.id,
    fromTenant: user.currentTenantId,
    toTenant: tenantId,
  })

  // Set a cookie with the desired tenant.
  // The auth.ts jwt callback will read this cookie on the next request
  // and reload the membership's roles/permissions for the new tenant.
  const cookieStore = await cookies()
  cookieStore.set('libredb-current-tenant', tenantId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365, // 1 year
    path: '/',
  })
}
