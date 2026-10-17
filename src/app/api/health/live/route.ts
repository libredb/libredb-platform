export const dynamic = 'force-dynamic'

/** Liveness and startup probe: answers while the process serves requests, without any I/O. */
export function GET() {
  return Response.json({ status: 'live' })
}
