// The secret store of the secrets step: the generated secrets and the issued seal keys. Values leave it only
// for the consumers that need them, and the installer state receives SHA-256 fingerprints, never a value.
import { createHash } from "node:crypto";
import type { SealKeyPair } from "./seal-keys";

export type SealKeyState = "live" | "retired";

/** A seal keypair the store issued. Studio's keyring holds the live ones; a retired key stays in the store. */
export interface SealKeyRecord extends SealKeyPair {
  state: SealKeyState;
}

/** The view of the store that may reach the installer state. */
export interface SecretFingerprints {
  /** Lowercase hex SHA-256 of each value, by name. */
  values: Record<string, string>;
  /** Every issued seal key in issue order, named by its kid, a SHA-256 fingerprint of the public key. */
  sealKeys: { kid: string; state: SealKeyState }[];
}

export interface SecretStore {
  /** Returns the value of each name, generating an absent one once; a present value is never regenerated. */
  ensure<N extends string>(names: readonly N[]): Promise<Record<N, string>>;
  /**
   * Stores a value supplied from outside instead of generated, such as an app client secret that the site's Keycloak
   * generated; returns whether the store changed.
   */
  put(name: string, value: string): Promise<boolean>;
  /** Returns the value of each name, and refuses a name the store does not hold. */
  get<N extends string>(names: readonly N[]): Promise<Record<N, string>>;
  /** Every seal key the store issued, in issue order. Issued keys are append-only. */
  sealKeys(): Promise<SealKeyRecord[]>;
  /** Issues the first live seal key when the store never issued one, and returns every issued key. */
  ensureSealKey(): Promise<SealKeyRecord[]>;
  /** Appends a new live seal key, and refuses one above the keyring limit that Studio accepts. */
  issueSealKey(): Promise<SealKeyRecord>;
  /** Marks a seal key retired and keeps it; returns false when it already was retired. */
  retireSealKey(kid: string): Promise<boolean>;
  fingerprints(): Promise<SecretFingerprints>;
}

/** A store that cannot be read, written or trusted. Its message never holds a secret value. */
export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

const SECRET_NAME = /^[a-z][a-z0-9._-]{0,127}$/;
const SECRET_NAME_RULE = "a lowercase letter followed by up to 127 lowercase letters, digits, '.', '_' or '-'";

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function invalidSecretName(name: string): string {
  return `invalid secret name ${JSON.stringify(name)}, expected ${SECRET_NAME_RULE}`;
}

/** Lowercase hex SHA-256 of a value. Every stored value is a high-entropy secret, so its digest reveals nothing. */
export function secretFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
