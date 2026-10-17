/**
 * LibreDB license tokens: the format of an offline license key, and its verification against the public keys compiled
 * into Platform.
 *
 * A token is one line of ASCII, `ldl1.<kid>.<payload>.<signature>`. `ldl1` names the format, LibreDB License version 1.
 * The kid is 16 lowercase hex digits, the first 8 bytes of the SHA-256 of the raw 32-byte Ed25519 public key that signed
 * the token, as the kids of sealed credentials are. The payload is the unpadded base64url of the UTF-8 of a JSON object,
 * and the signature the unpadded base64url of a 64-byte Ed25519 signature.
 *
 * The signature covers the ASCII of `libredb/license/v1`, a line feed, the kid, a line feed, and then the exact payload
 * bytes. The verifier checks the signature over those bytes before it parses them, and never serializes the payload
 * again, so no canonical JSON is involved. Each segment must be in its canonical encoding, so a token has exactly one
 * accepted spelling.
 *
 * This module uses node:crypto and zod alone, and reads no configuration: the caller passes the keys and the host. It
 * never passes an Ed25519 context option, which throws on some Node 24 releases, and no result or error carries the
 * token or key material.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import type { LicenseErrorCode } from './errors'

/** A verification key: its kid and the unpadded base64url of its raw 32-byte Ed25519 public key. */
export interface LicenseKey {
  readonly kid: string
  readonly publicKey: string
}

/** The verification keys by kid, as `licenseKeyring` loads them. */
export type LicenseKeyring = ReadonlyMap<string, KeyObject>

/** The content of a valid license. */
export interface LicensePayload {
  /** The format version, always 1. */
  readonly v: 1
  /** The license id: 1 to 64 ASCII letters, digits, dots, underscores and hyphens. */
  readonly id: string
  /** The customer's name, 1 to 200 characters, which Platform only displays. */
  readonly customer: string
  /** 0 to 100000. */
  readonly adminSeats: number
  /** 0 to 1000000. */
  readonly userSeats: number
  /** When the license was issued, in epoch seconds; a date still to come is accepted. */
  readonly issuedAt: number
  /** When the license expires, in epoch seconds, after issuedAt; expiry is a state, never a verification failure. */
  readonly expiresAt: number
  /** The hostnames the license may run on, 1 to 20, when it is bound to hosts. */
  readonly hosts?: readonly string[]
}

/** The outcome of verifying a token: the license it carries, or the code of the first check that failed. */
export type LicenseVerification =
  | { readonly ok: true; readonly license: LicensePayload }
  | { readonly ok: false; readonly code: LicenseErrorCode }

export interface VerifyLicenseOptions {
  /** The keys a token may be signed with: the compiled-in list of keys.ts, or test keys in tests. */
  readonly keyring: LicenseKeyring
  /**
   * The hostname of AUTH_URL, lowercase and without port, as `new URL(url).hostname` gives it, or null when AUTH_URL is
   * unset. A license bound to hosts verifies only when this host is one of them.
   */
  readonly host: string | null
}

const PREFIX = 'ldl1'
/** The text every signed message starts with, so a signature made for anything else never verifies as a license. */
const SIGNING_LABEL = 'libredb/license/v1'
const KID_PATTERN = /^[0-9a-f]{16}$/
const KID_BYTES = 8
const PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64
/** The DER that wraps a raw Ed25519 public key as SubjectPublicKeyInfo (RFC 8410), so node:crypto imports it. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * The y coordinate of each edwards25519 point of order 1, 2, 4 or 8, as the 255 low bits of its little-endian encoding:
 * 0 and 1, the two y of the points of order 8, p - 1, and the non-canonical p and p + 1 that decoders reduce to 0 and 1.
 * Under such a public key a signature made without any private key can verify, so the key list refuses each of them
 * with either sign bit.
 */
const SMALL_ORDER_Y: ReadonlySet<string> = new Set([
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
])

/** The last second of the year 9999 UTC. */
const LAST_EPOCH_SECOND = 253_402_300_799

/**
 * An instant in epoch seconds from 1970 through the year 9999, so that a Date holds it and the end of its grace period,
 * and a value written in milliseconds by mistake fails instead of reading as a date tens of thousands of years away.
 */
const epochSeconds = z.int().min(0).max(LAST_EPOCH_SECOND)

/**
 * A lowercase hostname without port, as `URL#hostname` gives it: labels of 1 to 63 lowercase letters, digits and inner
 * hyphens, joined by dots, 253 characters at most. An IPv4 address has this form as well.
 */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/**
 * A version 1 payload. Lengths count UTF-16 code units, as JavaScript strings do. A field the format does not name makes
 * the payload invalid, so a later format needs a new version.
 */
const payloadSchema: z.ZodType<LicensePayload> = z
  .strictObject({
    v: z.literal(1),
    id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    customer: z.string().min(1).max(200),
    adminSeats: z.int().min(0).max(100_000),
    userSeats: z.int().min(0).max(1_000_000),
    issuedAt: epochSeconds,
    expiresAt: epochSeconds,
    hosts: z.array(z.string().regex(HOSTNAME)).min(1).max(20).optional(),
  })
  .refine((payload) => payload.expiresAt > payload.issuedAt)

/**
 * Decodes unpadded base64url, and returns null for a text that is not the canonical encoding of the bytes it decodes
 * to: Node's decoder also reads padding, the standard base64 alphabet, stray characters and set unused bits.
 */
function canonicalBase64url(text: string): Buffer | null {
  const bytes = Buffer.from(text, 'base64url')
  return bytes.toString('base64url') === text ? bytes : null
}

function kidOf(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest().subarray(0, KID_BYTES).toString('hex')
}

function isSmallOrder(publicKey: Uint8Array): boolean {
  const y = Buffer.from(publicKey)
  y[31] &= 0x7f
  return SMALL_ORDER_Y.has(y.toString('hex'))
}

/**
 * Loads a key list for verification. It throws for a defect of the list, which is a defect of the build rather than of
 * any license: a kid that is not 16 lowercase hex digits, a key that is not the unpadded base64url of 32 bytes, a kid
 * that is not derived from its key, a point of small order, or a kid listed twice. Its messages name the position of the
 * key in the list and never the key.
 */
export function licenseKeyring(keys: readonly LicenseKey[]): LicenseKeyring {
  const keyring = new Map<string, KeyObject>()
  keys.forEach((key, index) => {
    const where = `License key ${index}`
    if (!KID_PATTERN.test(key.kid)) throw new Error(`${where} has a kid that is not 16 lowercase hex digits`)
    const raw = canonicalBase64url(key.publicKey)
    if (raw === null || raw.length !== PUBLIC_KEY_BYTES) {
      throw new Error(`${where} is not the unpadded base64url of a raw 32-byte Ed25519 public key`)
    }
    if (kidOf(raw) !== key.kid) throw new Error(`${where} has a kid that is not derived from its public key`)
    if (isSmallOrder(raw)) throw new Error(`${where} is a point of small order`)
    if (keyring.has(key.kid)) throw new Error(`${where} repeats the kid of an earlier key`)
    keyring.set(key.kid, createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' }))
  })
  return keyring
}

/**
 * The license of signed payload bytes, or null when they are not the UTF-8 of one JSON object that is a valid version
 * 1 payload. The decoder refuses bytes that are not UTF-8 and keeps a byte order mark, which JSON.parse then refuses.
 */
function parsePayload(bytes: Uint8Array): LicensePayload | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    return null
  }
  const parsed = payloadSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function failure(code: LicenseErrorCode): LicenseVerification {
  return { ok: false, code }
}

/**
 * Verifies a license token, and stops at the first check that fails, with its code:
 * 1. the `ldl1` prefix and exactly four dot-separated segments, else LICENSE_MALFORMED;
 * 2. a kid of 16 lowercase hex digits, and a payload and signature in canonical base64url, else LICENSE_MALFORMED;
 * 3. a kid in the keyring, else LICENSE_UNKNOWN_KID;
 * 4. a signature of exactly 64 bytes, else LICENSE_MALFORMED;
 * 5. a signature that verifies under the key of the kid, else LICENSE_BAD_SIGNATURE;
 * 6. a payload that is a valid version 1 license, else LICENSE_PAYLOAD_INVALID;
 * 7. when the license lists hosts, `options.host` among them, else LICENSE_HOST_MISMATCH.
 * It reads no clock, never throws for any text, and a failure carries its code alone.
 */
export function verifyLicenseToken(token: string, options: VerifyLicenseOptions): LicenseVerification {
  const segments = token.split('.')
  if (segments.length !== 4 || segments[0] !== PREFIX) return failure('LICENSE_MALFORMED')

  const [, kid, payloadText, signatureText] = segments
  const payload = canonicalBase64url(payloadText)
  const signature = canonicalBase64url(signatureText)
  if (!KID_PATTERN.test(kid) || payload === null || signature === null) return failure('LICENSE_MALFORMED')

  const publicKey = options.keyring.get(kid)
  if (publicKey === undefined) return failure('LICENSE_UNKNOWN_KID')
  if (signature.length !== SIGNATURE_BYTES) return failure('LICENSE_MALFORMED')

  const message = Buffer.concat([Buffer.from(`${SIGNING_LABEL}\n${kid}\n`, 'ascii'), payload])
  if (!verify(null, message, publicKey, signature)) return failure('LICENSE_BAD_SIGNATURE')

  const license = parsePayload(payload)
  if (license === null) return failure('LICENSE_PAYLOAD_INVALID')
  if (license.hosts !== undefined && (options.host === null || !license.hosts.includes(options.host))) {
    return failure('LICENSE_HOST_MISMATCH')
  }
  return { ok: true, license }
}
