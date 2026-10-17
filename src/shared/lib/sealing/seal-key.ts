/**
 * Studio's seal public key, the only key Platform holds: `BRIDGE_SEAL_PUBLIC_KEY` is the unpadded base64url
 * of the raw 32-byte X25519 public key that every connection credential is sealed to, and its kid names each envelope
 * sealed to it. The private key stays in Studio's keyring, so Platform seals and never opens.
 *
 * At boot, register() loads the key with a self-test seal of its canary, so a key that nothing can be sealed to, such as
 * a point of small order, stops the start instead of failing the first credential an admin enters. In self-hosted mode
 * Platform then publishes the key's canary for Studio (bridge/seal-canary.ts), which opens it on every load and reports
 * the result per kid in its heartbeat, so a wrong public key shows before the first real connection exists.
 */
import { ConfigError } from '../errors'
import { kidOf, SealError, sealSecret, type CredentialSet, type SealBinding, type SealDeps } from './lsb1'

/** The variable that holds Studio's seal public key. */
export const SEAL_PUBLIC_KEY_VARIABLE = 'BRIDGE_SEAL_PUBLIC_KEY'

/** The rule of BRIDGE_SEAL_PUBLIC_KEY, shared with the runtime configuration so both report the same message. */
export const SEAL_PUBLIC_KEY_RULE = 'must be the unpadded base64url of a raw 32-byte X25519 public key'

/** The bytes of a raw X25519 public key. */
const PUBLIC_KEY_BYTES = 32

/** Studio's seal public key. */
export interface SealKey {
  /** The raw 32 bytes of the X25519 public key. */
  readonly publicKey: Buffer
  /** The lowercase hex of the first 8 bytes of the SHA-256 of the public key, which every envelope sealed to it names. */
  readonly kid: string
}

/** The row the canary is sealed for: connection `canary`, level `read`, engine `canary`, definition `{}`. */
const CANARY_BINDING: SealBinding = { connectionId: 'canary', level: 'read', engine: 'canary', definition: {} }

/** The credential set the canary carries. */
const CANARY_PLAINTEXT: CredentialSet = { user: 'libredb-canary' }

/**
 * Reads the text of BRIDGE_SEAL_PUBLIC_KEY: the unpadded base64url of exactly 32 bytes, as `Buffer#toString('base64url')`
 * writes it. Node's decoder also reads padding, standard base64 and stray characters, so any text that is not the
 * canonical encoding of the bytes it decodes to is refused. Returns null for every text that is not a key.
 */
export function parseSealPublicKey(text: string): SealKey | null {
  const publicKey = Buffer.from(text, 'base64url')
  if (publicKey.length !== PUBLIC_KEY_BYTES || publicKey.toString('base64url') !== text) return null
  return { publicKey, kid: kidOf(publicKey) }
}

/**
 * The canary envelope of `key`: `{"user":"libredb-canary"}` sealed for connection `canary`, level `read`,
 * engine `canary` and definition `{}`. It fails with the SealError of `sealSecret`, such as LOW_ORDER_POINT for a key that
 * nothing can be sealed to. Only tests pass `deps`, to reproduce the canary vector with its fixed ephemeral key.
 */
export function sealCanary(key: SealKey, deps?: SealDeps): string {
  return sealSecret({ ...CANARY_BINDING, plaintext: CANARY_PLAINTEXT }, key.publicKey, deps)
}

/**
 * Loads the text of BRIDGE_SEAL_PUBLIC_KEY as a seal key and runs its self-test seal, which seals the canary to it.
 * Throws a ConfigError that names the variable, and never its value: for a text that is not a key, and with the SealError
 * code, kept as the cause, for a key that nothing can be sealed to.
 */
export function loadSealKey(text: string): SealKey {
  const key = parseSealPublicKey(text)
  if (key === null) throw new ConfigError(`${SEAL_PUBLIC_KEY_VARIABLE} ${SEAL_PUBLIC_KEY_RULE}`)
  try {
    sealCanary(key)
  } catch (error) {
    if (!(error instanceof SealError)) throw error
    const failure = new ConfigError(`${SEAL_PUBLIC_KEY_VARIABLE} fails the self-test seal: ${error.message}`)
    failure.cause = error
    throw failure
  }
  return key
}
