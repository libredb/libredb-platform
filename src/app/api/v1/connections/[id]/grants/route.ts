import { NextResponse } from 'next/server'
import { withBearer } from '@/shared/lib/bearer/with-bearer'
import { listConnectionGrants } from '@/features/connections/lib/grant-service'

type Context = { params: Promise<{ id: string }> }

// The grants of a connection of the install tenant.
export const GET = withBearer<Context>(async (user, _request, { params }) => {
  const { id } = await params
  return NextResponse.json({ grants: await listConnectionGrants(id, user) })
})
