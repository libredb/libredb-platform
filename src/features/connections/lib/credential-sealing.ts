import { ConfigError } from '@/shared/lib/errors'
import { getRuntimeConfig } from '@/shared/lib/runtime-config'
import { sealSecret, type CredentialSet, type SealBinding } from '@/shared/lib/sealing/lsb1'
import { loadSealKey, SEAL_PUBLIC_KEY_VARIABLE, type SealKey } from '@/shared/lib/sealing/seal-key'

/**
 * Studio's seal public key, which every connection credential is sealed to. Self-hosted mode requires
 * BRIDGE_SEAL_PUBLIC_KEY to start, while cloud mode may run without it, and then no credential can be sealed: this
 * throws a ConfigError that names the variable.
 */
export function requireSealKey(): SealKey {
  const text = getRuntimeConfig().BRIDGE_SEAL_PUBLIC_KEY
  if (text === undefined) {
    throw new ConfigError(`${SEAL_PUBLIC_KEY_VARIABLE} is required to seal connection credentials`)
  }
  return loadSealKey(text)
}

/** Seals a credential set for one level of a connection: its id, engine and exact definition enter the AAD. */
export function sealCredential(
  key: SealKey,
  binding: Omit<SealBinding, 'level'>,
  level: SealBinding['level'],
  credential: CredentialSet,
): string {
  return sealSecret({ ...binding, level, plaintext: credential }, key.publicKey)
}
