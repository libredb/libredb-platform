import type { PrismaClient } from '@prisma/client'

// Bridge contract v1, as Studio's GOVERNANCE.md defines it: Platform publishes it in schema bridge, and Studio reads it
// with its own role.
// tests/db/contract-conformance.db.test.ts checks the migrated database against the manifest of the vendored Studio build.

/** The bridge contract version this build of Platform publishes and serves. */
export const PLATFORM_BRIDGE_CONTRACT_VERSION = 1

/** The channel of the bridge change notifications, also published as bridge.contract.notify_channel. */
export const BRIDGE_NOTIFY_CHANNEL = 'libredb_bridge'

export const BRIDGE_CONTRACT_STATUSES = ['current', 'deprecated'] as const
export type BridgeContractStatus = (typeof BRIDGE_CONTRACT_STATUSES)[number]

/** A contract version as bridge.contract publishes it. */
export interface PublishedContract {
  version: number
  status: BridgeContractStatus
  /** The time after which Platform may drop the version, or null while it has none. */
  sunsetAfter: Date | null
  notifyChannel: string
}

type Queryable = Pick<PrismaClient, '$queryRaw'>

function isContractStatus(status: string): status is BridgeContractStatus {
  return (BRIDGE_CONTRACT_STATUSES as readonly string[]).includes(status)
}

/** The contract versions that bridge.contract publishes, in version order. */
export async function readPublishedContracts(client: Queryable): Promise<PublishedContract[]> {
  const rows = await client.$queryRaw<{ version: number; status: string; sunset_after: Date | null; notify_channel: string }[]>`
    SELECT version, status, sunset_after, notify_channel FROM bridge.contract ORDER BY version`
  return rows.map(row => {
    if (!isContractStatus(row.status)) {
      throw new Error(`bridge.contract lists version ${row.version} with status ${row.status}, which is neither current nor deprecated`)
    }
    return { version: row.version, status: row.status, sunsetAfter: row.sunset_after, notifyChannel: row.notify_channel }
  })
}
