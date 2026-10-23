import { NextResponse } from 'next/server'
import { withBearer } from '@/shared/lib/bearer/with-bearer'
import { listGrantableConnections } from '@/features/connections/lib/grant-service'

// The connections of the install tenant that a grant can name, without any credential or host.
export const GET = withBearer(async user => NextResponse.json({ connections: await listGrantableConnections(user) }))
