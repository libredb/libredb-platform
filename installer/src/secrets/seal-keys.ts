// X25519 seal keypairs of the lsb1 envelopes of Studio's GOVERNANCE.md. Studio's keyring holds the private keys,
// Platform's BRIDGE_SEAL_PUBLIC_KEY holds a public key, and the kid names a keypair in every lsb1 envelope.
import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";

export const SEAL_KEY_BYTES = 32;

export interface SealKeyPair {
  /** Lowercase hex of the first 8 bytes of SHA-256 of the raw public key. */
  kid: string;
  /** base64url without padding of the raw 32-byte X25519 public key. */
  publicKey: string;
  /** base64url without padding of the raw 32-byte X25519 private key. */
  privateKey: string;
}

// The DER prefix of an X25519 private key in PKCS#8 (RFC 8410); the 32 raw key bytes follow it.
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** True when the value is the canonical base64url of exactly 32 bytes, the form of every raw seal key. */
export function isRawSealKey(value: string): boolean {
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === SEAL_KEY_BYTES && bytes.toString("base64url") === value;
}

/** The kid of a raw public key given as base64url, as Platform derives it from BRIDGE_SEAL_PUBLIC_KEY. */
export function sealKeyId(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest().subarray(0, 8).toString("hex");
}

function pairOf(privateKey: KeyObject): SealKeyPair {
  // The JWK of an X25519 private key carries both raw keys as base64url without padding (RFC 8037).
  const { d, x } = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  return { kid: sealKeyId(x), publicKey: x, privateKey: d };
}

/** Generates a new keypair, an independent draw that derives from no other secret. */
export function generateSealKeyPair(): SealKeyPair {
  return pairOf(generateKeyPairSync("x25519").privateKey);
}

/** Derives the public key and the kid of a raw private key given as base64url. */
export function sealKeyPairFromPrivateKey(privateKey: string): SealKeyPair {
  if (!isRawSealKey(privateKey)) {
    throw new Error("a seal private key must be the base64url of a raw 32-byte X25519 private key");
  }
  const der = Buffer.concat([PKCS8_X25519_PREFIX, Buffer.from(privateKey, "base64url")]);
  return pairOf(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
}
