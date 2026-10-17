import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'

// Ed25519 keys that sign licenses in tests only. Each private key is the SHA-256 of the UTF-8 of its published label,
// so anyone can derive it and it protects nothing: never sign a real license with one, and never add one to
// src/shared/lib/license/keys.ts, which keys.test.ts checks.

export interface TestLicenseKey {
  readonly privateKey: KeyObject
  /** The unpadded base64url of the raw 32-byte public key. */
  readonly publicKey: string
  /** The lowercase hex of the first 8 bytes of the SHA-256 of the raw public key. */
  readonly kid: string
}

/** The DER that wraps a raw 32-byte Ed25519 private key as PKCS #8 (RFC 8410). */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
/** The length of the DER that precedes the raw key in an Ed25519 SubjectPublicKeyInfo. */
const SPKI_PREFIX_LENGTH = 12

function testLicenseKey(label: string): TestLicenseKey {
  const seed = createHash('sha256').update(label, 'utf8').digest()
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX_LENGTH)
  const kid = createHash('sha256').update(raw).digest().subarray(0, 8).toString('hex')
  return { privateKey, publicKey: raw.toString('base64url'), kid }
}

export const LICENSE_TEST_KEY = testLicenseKey('libredb ldl1 test keys, test only: license key')
export const OTHER_LICENSE_TEST_KEY = testLicenseKey('libredb ldl1 test keys, test only: other license key')

/** The bytes an ldl1 signature covers: the ASCII of `libredb/license/v1`, LF, the kid, LF, then the payload bytes. */
export function signedMessage(kid: string, payload: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`libredb/license/v1\n${kid}\n`, 'ascii'), payload])
}

/**
 * The ldl1 token of `payload` signed by `key` for `kid`, the key's own kid by default. A payload that is not bytes is
 * signed as the UTF-8 of its JSON text.
 */
export function signLicense(key: TestLicenseKey, payload: unknown, kid: string = key.kid): string {
  const bytes = payload instanceof Uint8Array ? Buffer.from(payload) : Buffer.from(JSON.stringify(payload), 'utf8')
  const signature = sign(null, signedMessage(kid, bytes), key.privateKey)
  return ['ldl1', kid, bytes.toString('base64url'), signature.toString('base64url')].join('.')
}
