import { NextResponse } from 'next/server'
import { withBearer } from '@/shared/lib/bearer/with-bearer'
import { parseApiInput, readJsonObject } from '@/shared/lib/bearer/api-v1-input'
import { setConnectionActive } from '@/features/connections/lib/connection-service'
import { setConnectionActiveSchema } from '@/features/connections/lib/database-connection.schema'

type Context = { params: Promise<{ id: string }> }

// Turns a connection of the install tenant active or inactive, and answers it as GET /api/v1/connections lists it.
export const PATCH = withBearer<Context>(async (user, request, { params }) => {
  const { id } = await params
  const { active } = parseApiInput(setConnectionActiveSchema, await readJsonObject(request))
  return NextResponse.json(await setConnectionActive(id, active, user, 'api'))
})
