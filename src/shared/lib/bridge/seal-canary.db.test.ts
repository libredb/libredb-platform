import { generateKeyPairSync } from 'node:crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectStudio, connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { parseSealPublicKey, type SealKey } from '@/shared/lib/sealing/seal-key'

interface CanaryRow {
  kid: string
  envelope: string
  created_at: Date
}

// A fresh key pair per run, so its kid is this file's own and the cleanup removes exactly its row.
function freshSealKey(): SealKey {
  const text = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x as string
  const key = parseSealPublicKey(text)
  if (key === null) throw new Error('node:crypto exported an X25519 public key that is not a seal key')
  return key
}

describe('seal canary publication on PostgreSQL', () => {
  let canary: typeof import('./seal-canary')
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client
  let studio: Client
  const key = freshSealKey()

  // What Studio reads.
  async function canaryRows(): Promise<CanaryRow[]> {
    const result = await studio.query<CanaryRow>('SELECT kid, envelope, created_at FROM "bridge".seal_canary_v1 WHERE kid = $1', [
      key.kid,
    ])
    return result.rows
  }

  beforeAll(async () => {
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    canary = await import('./seal-canary')
    superuser = await connectSuperuser()
    studio = await connectStudio()
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.seal_canary WHERE kid = $1', [key.kid])
    await superuser.end()
    await studio.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it("publishes one canary row for the key's kid, and a second call changes nothing", async () => {
    expect(await canaryRows()).toEqual([])

    await expect(canary.publishSealCanary(db, key)).resolves.toBe(true)
    const published = await canaryRows()
    expect(published).toHaveLength(1)
    // The envelope is sealed to this key: lsb1, the key's kid, the 32 bytes of enc and the sealed canary with its tag.
    expect(published[0].envelope).toMatch(new RegExp(`^lsb1\\.${key.kid}\\.[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{22,}$`))

    await expect(canary.publishSealCanary(db, key)).resolves.toBe(false)
    expect(await canaryRows()).toEqual(published)
  })
})
