import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../errors'
import { SealError } from './lsb1'
import { loadSealKey, parseSealPublicKey, sealCanary } from './seal-key'

// Studio's lsb1 test vectors, vendored by scripts/vendor-studio-governance.mjs.
// Every key in them is a published test key that protects nothing.
const VECTORS_FILE = path.resolve(__dirname, '../../../../tests/fixtures/governance/lsb1-vectors.json')

interface Vector {
  id: string
  recipientPublicKey: string
  kid: string
  binding: { connectionId: string; level: string; engine: string; definition: Record<string, unknown> }
  ephemeralPrivateKey: string
  plaintext: Record<string, unknown>
  envelope: string
  opening: { envelope: string }
}

const vectors: Vector[] = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors

function vector(id: string): Vector {
  const found = vectors.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`lsb1-vectors.json has no vector ${id}`)
  return found
}

// The recipient key of the vectors and its kid, as the vectors file states them.
const RECIPIENT = 'b6-f045B6re3Ue7V8Cr5jO9ApZzyOxGk659gM3tn5wE'
const RECIPIENT_KID = 'caea4ffac78f6e7c'

// 32 zero bytes, the X25519 point of order 2: the form of a key, and a key that nothing can be sealed to.
const ALL_ZERO_KEY = 'A'.repeat(43)

// The ConfigError that `run` throws.
function configErrorOf(run: () => unknown): ConfigError {
  try {
    run()
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('expected a ConfigError')
}

describe('parseSealPublicKey', () => {
  it('refuses a key that is not 32 bytes', () => {
    for (const length of [0, 1, 16, 31, 33, 64]) {
      // Fixed bytes, whose text does not occur in the message: random bytes failed one run in 128, because a single byte
      // such as 0x10 or 0x6b encodes to two characters that the message contains, EA of SEAL and aw of raw.
      const text = Buffer.alloc(length, 0xfb).toString('base64url')
      expect(parseSealPublicKey(text), `${length} bytes`).toBeNull()

      const error = configErrorOf(() => loadSealKey(text))
      expect(error.message).toMatch(/^BRIDGE_SEAL_PUBLIC_KEY must be the unpadded base64url of a raw 32-byte X25519 public key/)
      if (text !== '') expect(error.message).not.toContain(text)
    }
  })

  it('refuses text that is not the canonical unpadded base64url of 32 bytes', () => {
    const raw = Buffer.from(RECIPIENT, 'base64url')
    for (const text of [
      `${RECIPIENT}=`,
      // Standard base64, which Node's base64url decoder also reads.
      raw.toString('base64').replace(/=+$/, ''),
      // The last character carries two bits that the canonical encoding leaves at zero.
      `${RECIPIENT.slice(0, -1)}F`,
      ` ${RECIPIENT}`,
      `${RECIPIENT}\n`,
      raw.toString('hex'),
    ]) {
      expect(parseSealPublicKey(text), JSON.stringify(text)).toBeNull()
    }
  })

  it('reads the unpadded base64url of a raw 32-byte key and derives its kid', () => {
    expect(parseSealPublicKey(RECIPIENT)).toEqual({ publicKey: Buffer.from(RECIPIENT, 'base64url'), kid: RECIPIENT_KID })
  })
})

describe('sealCanary', () => {
  it('seals the canary byte for byte as the canary vector', () => {
    const canary = vector('canary')
    // The canary vector is the canary that Studio's GOVERNANCE.md defines.
    expect(canary.binding).toEqual({ connectionId: 'canary', level: 'read', engine: 'canary', definition: {} })
    expect(canary.plaintext).toEqual({ user: 'libredb-canary' })

    const key = { publicKey: Buffer.from(canary.recipientPublicKey, 'base64url'), kid: canary.kid }
    const envelope = sealCanary(key, { ephemeralPrivateKey: Buffer.from(canary.ephemeralPrivateKey, 'base64url') })
    expect(envelope).toBe(canary.envelope)
  })
})

describe('loadSealKey', () => {
  it('the self-test of an all-zero key fails with LOW_ORDER_POINT', () => {
    // The text has the form of a key, so only the self-test seal can refuse it.
    expect(parseSealPublicKey(ALL_ZERO_KEY)).not.toBeNull()

    const error = configErrorOf(() => loadSealKey(ALL_ZERO_KEY))
    expect(error.message).toMatch(/^BRIDGE_SEAL_PUBLIC_KEY fails the self-test seal: .*\(LOW_ORDER_POINT\)$/)
    expect(error.cause).toBeInstanceOf(SealError)
    expect((error.cause as SealError).code).toBe('LOW_ORDER_POINT')
  })

  it('the self-test of a point of order 8 fails with LOW_ORDER_POINT', () => {
    // The enc of the vector low-order-point-order-eight, a point of order 8 on Curve25519.
    const orderEight = vector('low-order-point-order-eight').opening.envelope.split('.')[2]

    const error = configErrorOf(() => loadSealKey(orderEight))
    expect(error.message).toContain('BRIDGE_SEAL_PUBLIC_KEY')
    expect((error.cause as SealError).code).toBe('LOW_ORDER_POINT')
  })

  it('returns the key and kid of a key that passes the self-test', () => {
    expect(loadSealKey(RECIPIENT)).toEqual({ publicKey: Buffer.from(RECIPIENT, 'base64url'), kid: RECIPIENT_KID })

    const fresh = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x as string
    const key = loadSealKey(fresh)
    expect(key.publicKey).toEqual(Buffer.from(fresh, 'base64url'))
    expect(key.kid).toMatch(/^[0-9a-f]{16}$/)
  })
})
