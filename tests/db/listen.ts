import { randomUUID } from 'crypto'
import type { Notification } from 'pg'
import { connectAs, type FixtureRole } from './connect'

// The channel of the bridge change notifications, also published as bridge.contract.notify_channel.
export const BRIDGE_CHANNEL = 'libredb_bridge'

const FLUSH_TIMEOUT_MS = 5_000

export interface BridgeListener {
  // Resolves with the payloads, parsed as JSON, of the notifications on libredb_bridge that were committed before
  // this call and not returned by an earlier flush, in delivery order, for example [{ v: 1, kind: 'canary' }].
  flush(): Promise<unknown[]>
  close(): Promise<void>
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch {
    throw new Error(`a notification on ${BRIDGE_CHANNEL} has a payload that is not JSON: ${payload}`)
  }
}

// Collects the notifications on libredb_bridge on a dedicated connection, as Studio's listener does.
// The default role is libredb_studio, the role Studio listens as, and the default database is libredb.
// flush() sends a marker notification on the channel from the listening connection and waits for it.
// PostgreSQL delivers notifications in commit order, so every notification committed before the marker arrives
// before it, and a transaction that has not committed, or rolled back, has delivered nothing by then.
export async function listenBridge(role: FixtureRole = 'studio', database?: string): Promise<BridgeListener> {
  const client = await connectAs(role, database)
  const markers = new Map<string, (payloads: string[]) => void>()
  let received: string[] = []

  client.on('notification', (notification: Notification) => {
    if (notification.channel !== BRIDGE_CHANNEL) return
    const payload = notification.payload ?? ''
    const marker = markers.get(payload)
    if (marker === undefined) {
      received.push(payload)
      return
    }
    markers.delete(payload)
    const payloads = received
    received = []
    marker(payloads)
  })
  await client.query(`LISTEN ${BRIDGE_CHANNEL}`)

  return {
    async flush() {
      const marker = `flush:${randomUUID()}`
      let timer: NodeJS.Timeout | undefined
      const arrived = new Promise<string[]>((resolve, reject) => {
        markers.set(marker, resolve)
        timer = setTimeout(
          () => reject(new Error(`the flush marker did not arrive on ${BRIDGE_CHANNEL} within ${FLUSH_TIMEOUT_MS} ms`)),
          FLUSH_TIMEOUT_MS,
        )
      })
      // The rejection is awaited below; this keeps it from counting as unhandled while the marker is being sent.
      arrived.catch(() => undefined)
      try {
        await client.query('SELECT pg_notify($1, $2)', [BRIDGE_CHANNEL, marker])
        return (await arrived).map(parsePayload)
      } finally {
        clearTimeout(timer)
        markers.delete(marker)
      }
    },
    async close() {
      await client.end()
    },
  }
}
