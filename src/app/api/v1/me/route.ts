import { NextResponse } from 'next/server'
import { withBearer } from '@/shared/lib/bearer/with-bearer'

// The caller's Platform user and rights. LibreDB Mobile reads Platform's rights from this answer, never from the claims
// of its token.
export const GET = withBearer(async user => {
  const tenant = user.accessibleTenants.find(candidate => candidate.id === user.currentTenantId)
  if (tenant === undefined) throw new Error('A bearer user carries no install tenant')
  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    roles: user.roles,
    permissions: user.permissions,
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
  })
})
