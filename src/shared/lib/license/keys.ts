import type { LicenseKey } from './token'

/**
 * The public keys that sign LibreDB licenses, compiled into Platform so that no configuration can add one.
 *
 * Each entry holds the kid and the unpadded base64url of the raw 32-byte Ed25519 public key; keys.test.ts checks that
 * every kid is derived from its key and that no key is a point of small order. A new signing key joins this list in a
 * release before any license signed with it ships, so the signing key can rotate, and a key stays here while a license
 * it signed is still in use. A token signed by any other key names an unknown kid, so an install runs on the free tier.
 */
export const LICENSE_KEYS: readonly LicenseKey[] = [
  // The licensor's first production signing key, created on 2026-10-16.
  { kid: '12249e10bb1cd24a', publicKey: 'PuksieOfy12tkBQImpRdu7MxYLe5MTLyTqvMNymF4zk' },
]
