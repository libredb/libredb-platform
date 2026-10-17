// Studio's governance keyring, rendered from the live seal keys and checked against the rules that stop Studio's
// boot (Studio's GOVERNANCE.md, Keyring), so the installer never delivers a keyring that Studio refuses.
import { isRawSealKey, sealKeyPairFromPrivateKey } from "./seal-keys";
import type { SealKeyRecord } from "./store";

/** The heartbeat's keyring_kids column holds at most 16 kids, so Studio refuses a larger keyring. */
export const MAX_KEYRING_KEYS = 16;

/** A keyring Studio would refuse. Its message names positions and kids, never key material. */
export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringError";
  }
}

/** Renders `{"version":1,"keys":[...]}` with the private key of every live seal key, in issue order. */
export function renderKeyring(sealKeys: readonly SealKeyRecord[]): string {
  const live = sealKeys.filter((key) => key.state === "live");
  if (live.length === 0) {
    throw new KeyringError("the keyring would hold no live seal key, and Studio refuses an empty keyring");
  }
  if (live.length > MAX_KEYRING_KEYS) {
    throw new KeyringError(
      `the keyring would hold ${live.length} live seal keys, above the limit of ${MAX_KEYRING_KEYS} that Studio accepts`,
    );
  }
  const kids = new Set<string>();
  for (const [index, key] of live.entries()) {
    if (!isRawSealKey(key.privateKey)) {
      throw new KeyringError(
        `live seal key ${index + 1} is not the base64url of a raw 32-byte X25519 private key, and Studio refuses it`,
      );
    }
    // The kid comes from the private key itself: two encodings of one X25519 scalar share a public key and a kid.
    const { kid } = sealKeyPairFromPrivateKey(key.privateKey);
    if (kids.has(kid)) {
      throw new KeyringError(`the keyring would hold kid ${kid} twice, and Studio refuses a duplicate kid`);
    }
    kids.add(kid);
  }
  return JSON.stringify({ version: 1, keys: live.map((key) => key.privateKey) });
}
