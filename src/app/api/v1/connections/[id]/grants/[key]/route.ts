import { NextResponse } from 'next/server'
import { withBearer } from '@/shared/lib/bearer/with-bearer'
import { parseApiInput, readJsonObject } from '@/shared/lib/bearer/api-v1-input'
import { revokeGrant, setGrant } from '@/features/connections/lib/grant-service'
import { setConnectionGrantSchema } from '@/features/connections/lib/grant.schema'

// The last segment is the subject of a PUT, the Keycloak user id, and the grant id of a DELETE, as the grant actions
// take them (docs/api/v1.md).
type Context = { params: Promise<{ id: string; key: string }> }

// The body of a PUT: the path names the connection and the subject.
const grantBodySchema = setConnectionGrantSchema.pick({ level: true, expiresAt: true })

// Creates the grant of the subject on the connection, or replaces the one it has.
export const PUT = withBearer<Context>(async (user, request, { params }) => {
  const { id, key } = await params
  const body = parseApiInput(grantBodySchema, await readJsonObject(request))
  const input = parseApiInput(setConnectionGrantSchema, { ...body, connectionId: id, subject: key })
  return NextResponse.json(await setGrant(input, user, 'api'))
})

// Revokes a grant of the connection.
export const DELETE = withBearer<Context>(async (user, _request, { params }) => {
  const { id, key } = await params
  await revokeGrant({ grantId: key, connectionId: id }, user, 'api')
  return new Response(null, { status: 204 })
})
