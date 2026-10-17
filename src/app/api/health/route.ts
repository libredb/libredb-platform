import { db } from '@/shared/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`
    return Response.json({ status: 'ok', timestamp: new Date().toISOString() })
  } catch {
    return Response.json({ status: 'error', timestamp: new Date().toISOString() }, { status: 503 })
  }
}
