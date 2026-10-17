import { checkReadiness } from '@/shared/lib/bridge/readiness'
import { db } from '@/shared/lib/db'

export const dynamic = 'force-dynamic'

/** Readiness probe: 200 only when every local migration is applied and bridge.contract lists version 1. */
export async function GET() {
  const readiness = await checkReadiness(db)
  return Response.json(readiness, { status: readiness.status === 'ready' ? 200 : 503 })
}
