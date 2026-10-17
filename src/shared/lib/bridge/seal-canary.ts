import type { PrismaClient } from '@prisma/client'
import { logger } from '@/shared/lib/logger'
import { sealCanary, type SealKey } from '@/shared/lib/sealing/seal-key'

// The seal canary: one envelope per kid in platform.seal_canary, which Studio reads through
// bridge.seal_canary_v1, opens on every load and reports as ok or an envelope code per kid in its heartbeat.
// A wrong public key in Platform therefore shows before the first real connection is created.

/** The pause after a failed attempt to publish the canary, such as during a database outage at boot. */
export const SEAL_CANARY_RETRY_MS = 30_000

/** The part of the Prisma client that publishes the canary. */
export type SealCanaryClient = Pick<PrismaClient, '$executeRaw'>

/**
 * Inserts the canary envelope of `key` under the key's kid, unless the kid has a canary already: Studio opens any
 * envelope sealed to its key, so the first one stays, and a restart with the same key changes no row.
 * Returns true when this call inserted the row.
 */
export async function publishSealCanary(client: SealCanaryClient, key: SealKey): Promise<boolean> {
  const envelope = sealCanary(key)
  const inserted = await client.$executeRaw`INSERT INTO platform.seal_canary (kid, envelope) VALUES (${key.kid}, ${envelope})
    ON CONFLICT (kid) DO NOTHING`
  return inserted > 0
}

/**
 * Publishes the canary of `key` in the background: the first attempt starts at once, and each failed attempt is logged
 * and followed by another 30 s later, until one succeeds. A failure is never thrown, so a database outage at boot delays
 * the canary without stopping Platform, and a pending retry never keeps the process alive.
 */
export function startSealCanaryPublication(client: SealCanaryClient, key: SealKey): void {
  async function attempt(): Promise<void> {
    try {
      const inserted = await publishSealCanary(client, key)
      logger.info(inserted ? 'Seal canary published' : 'Seal canary already published', { kid: key.kid })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      logger.error(`Publishing the seal canary failed, retrying in ${SEAL_CANARY_RETRY_MS / 1000} s`, failure, { kid: key.kid })
      setTimeout(() => void attempt(), SEAL_CANARY_RETRY_MS).unref?.()
    }
  }
  void attempt()
}
