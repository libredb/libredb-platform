/**
 * `lsb1` sealed secrets (Studio's GOVERNANCE.md): how Platform seals a connection credential to Studio's public key.
 *
 * An envelope is `lsb1.<kid>.<base64url(enc)>.<base64url(ciphertext || tag)>`. It is sealed with HPKE (RFC 9180) in
 * base mode with DHKEM(X25519, HKDF-SHA256) `0x0020`, HKDF-SHA256 `0x0001` and AES-256-GCM `0x0002`, single shot,
 * with a fresh ephemeral key per seal, the `info` string `libredb/bridge/secret/v1` and no PSK. Its additional
 * authenticated data binds it to one connection id, level, engine, key id and canonical definition, so
 * Studio's opener fails with AUTH_FAILED when a database writer moves it to another row, points its connection at
 * another host or downgrades its TLS.
 *
 * Platform seals and never opens: only Studio holds the private keys, so this module has no function
 * that opens an envelope, and no-decrypt.test.ts fails when any file under src deciphers or exports an open, decrypt
 * or unseal function. It uses `node:crypto` alone, and lsb1.test.ts reproduces every envelope of Studio's vectors in
 * tests/fixtures/governance/lsb1-vectors.json byte for byte.
 */
import {
  createCipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'
import { AppError } from '../errors'
import { canonicalDefinition, canonicalJson, isPlainObject } from './jcs'

/** The keys a credential set may carry, each with a string value; none of them belongs in a definition. */
export const PLAINTEXT_KEYS = [
  'user',
  'password',
  'connectionString',
  'privateKey',
  'privateKeyPassphrase',
  'apiKeyId',
  'apiKeySecret',
  'sslClientKey',
  'sslClientCert',
] as const

/** The largest plaintext an envelope may carry: the UTF-8 bytes of the credential set's JSON text. */
export const PLAINTEXT_MAX_BYTES = 65536

export type PlaintextKey = (typeof PLAINTEXT_KEYS)[number]

/** A complete credential set for one level of a connection. */
export type CredentialSet = Readonly<Partial<Record<PlaintextKey, string>>>

/** The row an envelope is sealed for. */
export interface SealBinding {
  readonly connectionId: string
  readonly level: 'read' | 'write'
  readonly engine: string
  /** The connection's definition, which holds no credential, in any key order. */
  readonly definition: Readonly<Record<string, unknown>>
}

/** What `sealSecret` seals: a credential set for one level of one connection. */
export interface SealInput extends SealBinding {
  readonly plaintext: CredentialSet
}

export interface SealDeps {
  /**
   * A fixed raw 32-byte X25519 private key for the ephemeral key pair, which only tests pass, such as a vector's
   * `ephemeralPrivateKey`. Without it every seal draws a fresh key, as the lsb1 format requires.
   */
  readonly ephemeralPrivateKey?: Uint8Array
}

/** The lsb1 codes that the sealer raises. */
export type SealErrorCode = 'FORMAT' | 'LOW_ORDER_POINT' | 'PLAINTEXT_INVALID'

const SEAL_ERROR_MESSAGES: Readonly<Record<SealErrorCode, string>> = {
  FORMAT: 'The text is not an lsb1 envelope',
  LOW_ORDER_POINT: 'The seal public key gives an all-zero Diffie-Hellman result, so nothing can be sealed to it',
  PLAINTEXT_INVALID: `A credential set must be a JSON object of at most ${PLAINTEXT_MAX_BYTES} UTF-8 bytes whose keys are lsb1 credential keys and whose values are strings`,
}

/**
 * A credential could not be sealed, or a text is not an envelope. The message names the rule and the code, and never
 * carries a credential, key material or envelope text.
 */
export class SealError extends AppError {
  declare readonly code: SealErrorCode

  constructor(code: SealErrorCode, cause?: unknown) {
    super(`${SEAL_ERROR_MESSAGES[code]} (${code})`, code, code === 'PLAINTEXT_INVALID' ? 422 : 500)
    this.name = 'SealError'
    if (cause !== undefined) this.cause = cause
  }
}

/** The envelope format: the prefix of every envelope, and the `s` of its additional authenticated data. */
const FORMAT_ID = 'lsb1'
/** The HPKE `info` of every `lsb1` envelope. */
const SECRET_INFO = Buffer.from('libredb/bridge/secret/v1', 'utf8')
/** The lsb1 pattern: a 16-digit kid, the 32 bytes of enc in 43 characters, and at least the 16 bytes of the tag. */
const ENVELOPE_PATTERN = /^lsb1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22,})$/
const KID_BYTES = 8
const PLAINTEXT_KEY_SET: ReadonlySet<string> = new Set(PLAINTEXT_KEYS)

/** I2OSP(value, 2) of RFC 9180: the two-byte big-endian encoding. */
function twoBytes(value: number): Buffer {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16BE(value)
  return bytes
}

const KEM_ID = 0x0020
const KDF_ID = 0x0001
const AEAD_ID = 0x0002
const MODE_BASE = 0x00

/** Nsecret, Nenc, Npk and Nsk of DHKEM(X25519, HKDF-SHA256). */
const X25519_BYTES = 32
/** Nh of HKDF-SHA256. */
const HASH_BYTES = 32
/** Nk, Nn and Nt of AES-256-GCM. */
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

const EMPTY = Buffer.alloc(0)
const VERSION_LABEL = Buffer.from('HPKE-v1', 'utf8')
const KEM_SUITE_ID = Buffer.concat([Buffer.from('KEM', 'utf8'), twoBytes(KEM_ID)])
const HPKE_SUITE_ID = Buffer.concat([
  Buffer.from('HPKE', 'utf8'),
  twoBytes(KEM_ID),
  twoBytes(KDF_ID),
  twoBytes(AEAD_ID),
])

/** The DER that wraps a raw X25519 key as PKCS #8 and as SubjectPublicKeyInfo (RFC 8410), so node:crypto imports it. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

function assertX25519Length(raw: Uint8Array, kind: 'public' | 'private'): void {
  if (raw.length !== X25519_BYTES) {
    throw new RangeError(`An X25519 ${kind} key is ${X25519_BYTES} bytes, not ${raw.length}`)
  }
}

function x25519PublicKey(raw: Uint8Array): KeyObject {
  assertX25519Length(raw, 'public')
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

function x25519PrivateKey(raw: Uint8Array): KeyObject {
  assertX25519Length(raw, 'private')
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

/** The raw 32 bytes of the public key that belongs to an X25519 private key. */
function x25519RawPublicKey(privateKey: KeyObject): Buffer {
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length)
}

/** LabeledExtract of RFC 9180 section 4: HKDF-Extract of `"HPKE-v1" || suite_id || label || ikm` under `salt`. */
function labeledExtract(suiteId: Buffer, salt: Uint8Array, label: string, ikm: Uint8Array): Buffer {
  return createHmac('sha256', salt).update(VERSION_LABEL).update(suiteId).update(label, 'utf8').update(ikm).digest()
}

/**
 * LabeledExpand of RFC 9180 section 4: HKDF-Expand (RFC 5869) of `prk` to `length` bytes, with the info
 * `I2OSP(length, 2) || "HPKE-v1" || suite_id || label || info`.
 */
function labeledExpand(suiteId: Buffer, prk: Uint8Array, label: string, info: Uint8Array, length: number): Buffer {
  const labeledInfo = Buffer.concat([twoBytes(length), VERSION_LABEL, suiteId, Buffer.from(label, 'utf8'), info])
  const blocks: Buffer[] = []
  let previous = EMPTY
  for (let counter = 1; counter <= Math.ceil(length / HASH_BYTES); counter++) {
    previous = createHmac('sha256', prk).update(previous).update(labeledInfo).update(Buffer.of(counter)).digest()
    blocks.push(previous)
  }
  return Buffer.concat(blocks).subarray(0, length)
}

/**
 * DH(skE, pkR) of DHKEM(X25519). RFC 9180 section 7.1.4 refuses the all-zero result that a public key of small order
 * gives. OpenSSL refuses to compute it and throws instead, so a refused and an all-zero result are both
 * LOW_ORDER_POINT, as Studio's opener reports them.
 */
function x25519(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  let shared: Buffer
  try {
    shared = diffieHellman({ privateKey, publicKey })
  } catch (error) {
    throw new SealError('LOW_ORDER_POINT', error)
  }
  if (shared.every((byte) => byte === 0)) throw new SealError('LOW_ORDER_POINT')
  return shared
}

/** ExtractAndExpand of DHKEM(X25519, HKDF-SHA256): the KEM shared secret from a DH result and `enc || pkR`. */
function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dh)
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, X25519_BYTES)
}

/** KeySchedule of RFC 9180 section 5.1 in base mode, whose PSK and PSK id are empty, for the `lsb1` info. */
function keySchedule(sharedSecret: Uint8Array): { key: Buffer; baseNonce: Buffer } {
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, EMPTY, 'psk_id_hash', EMPTY)
  const infoHash = labeledExtract(HPKE_SUITE_ID, EMPTY, 'info_hash', SECRET_INFO)
  const context = Buffer.concat([Buffer.of(MODE_BASE), pskIdHash, infoHash])
  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, 'secret', EMPTY)
  return {
    key: labeledExpand(HPKE_SUITE_ID, secret, 'key', context, KEY_BYTES),
    baseNonce: labeledExpand(HPKE_SUITE_ID, secret, 'base_nonce', context, NONCE_BYTES),
  }
}

/**
 * The UTF-8 of the JSON text of a credential set, refused as PLAINTEXT_INVALID unless it is a JSON object
 * of at most PLAINTEXT_MAX_BYTES bytes whose keys are plaintext keys and whose values are strings.
 * The text is what `JSON.stringify` writes, which Studio's opener parses.
 */
function plaintextBytes(plaintext: unknown): Buffer {
  if (!isPlainObject(plaintext)) throw new SealError('PLAINTEXT_INVALID')
  for (const [key, value] of Object.entries(plaintext)) {
    if (!PLAINTEXT_KEY_SET.has(key) || typeof value !== 'string') throw new SealError('PLAINTEXT_INVALID')
  }
  const bytes = Buffer.from(JSON.stringify(plaintext), 'utf8')
  if (bytes.length > PLAINTEXT_MAX_BYTES) {
    bytes.fill(0)
    throw new SealError('PLAINTEXT_INVALID')
  }
  return bytes
}

/** The kid of an X25519 public key: the lowercase hex of the first 8 bytes of the SHA-256 of its raw 32 bytes. */
export function kidOf(rawPublicKey: Uint8Array): string {
  assertX25519Length(rawPublicKey, 'public')
  return createHash('sha256').update(rawPublicKey).digest().subarray(0, KID_BYTES).toString('hex')
}

/**
 * The additional authenticated data of an envelope sealed with `kid` for `binding`: the UTF-8 of the JCS
 * object `{c, d, e, k, l, s}`, whose `d` is the base64url SHA-256 of the UTF-8 of the canonical definition.
 * A definition outside the values lsb1 admits throws the CanonicalJsonError of `canonicalDefinition`.
 */
export function bindingAad(binding: SealBinding, kid: string): Buffer {
  const digest = createHash('sha256').update(canonicalDefinition(binding.definition), 'utf8').digest('base64url')
  const aad = { c: binding.connectionId, d: digest, e: binding.engine, k: kid, l: binding.level, s: FORMAT_ID }
  return Buffer.from(canonicalJson(aad), 'utf8')
}

/**
 * Seals the credential set `input.plaintext` for its connection, level, engine and definition to Studio's raw 32-byte
 * X25519 public key, and returns the `lsb1` envelope.
 *
 * It fails with a SealError: PLAINTEXT_INVALID for a plaintext that is not a credential set within PLAINTEXT_MAX_BYTES,
 * and LOW_ORDER_POINT for a public key of small order, which gives no Diffie-Hellman result. A definition outside the
 * values lsb1 admits throws a CanonicalJsonError, and a key that is not 32 bytes a RangeError.
 */
export function sealSecret(input: SealInput, publicKey: Uint8Array, deps: SealDeps = {}): string {
  const plaintext = plaintextBytes(input.plaintext)
  try {
    const kid = kidOf(publicKey)
    const aad = bindingAad(input, kid)
    const ephemeral =
      deps.ephemeralPrivateKey === undefined
        ? generateKeyPairSync('x25519').privateKey
        : x25519PrivateKey(deps.ephemeralPrivateKey)
    // Encap of DHKEM(X25519, HKDF-SHA256): enc is the ephemeral public key, and the KEM context is enc || pkR.
    const enc = x25519RawPublicKey(ephemeral)
    const dh = x25519(ephemeral, x25519PublicKey(publicKey))
    const { key, baseNonce } = keySchedule(extractAndExpand(dh, Buffer.concat([enc, publicKey])))
    // A single-shot seal is sequence 0, whose nonce is the base nonce.
    const cipher = createCipheriv('aes-256-gcm', key, baseNonce, { authTagLength: TAG_BYTES })
    cipher.setAAD(aad)
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    return `${FORMAT_ID}.${kid}.${enc.toString('base64url')}.${sealed.toString('base64url')}`
  } finally {
    plaintext.fill(0)
  }
}

/**
 * The kid an `lsb1` envelope names, which tells the Studio key it was sealed to. It reads the envelope's form and
 * opens nothing; a text that is not an `lsb1` envelope fails with a SealError FORMAT.
 */
export function envelopeKid(envelope: string): string {
  const match = ENVELOPE_PATTERN.exec(envelope)
  if (match === null) throw new SealError('FORMAT')
  return match[1]
}
