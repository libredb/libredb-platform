import { NextResponse } from 'next/server'
import { withBearer } from '@/shared/lib/bearer/with-bearer'
import { readAuditEvents } from '@/features/audit/lib/audit-read'

// The governed query events of the install tenant, with the filters and checks of GET /api/db/audit.
export const GET = withBearer(async (user, request) => {
  const tenantId = user.currentTenantId
  if (tenantId === null) throw new Error('A bearer user carries no install tenant')
  return NextResponse.json(await readAuditEvents({ ...user, currentTenantId: tenantId }, new URL(request.url).searchParams))
})
