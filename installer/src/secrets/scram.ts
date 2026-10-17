// SCRAM-SHA-256 verifiers (RFC 5802, RFC 7677) in PostgreSQL's format, so that provisioning sends a verifier and
// no cleartext password reaches the server or its logs.
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

export const SCRAM_DEFAULT_ITERATIONS = 4096;

// PostgreSQL and libpq run the password through SASLprep (RFC 4013), which leaves printable ASCII unchanged.
// Accepting only that range keeps this verifier equal to the one the server checks at login.
const SASLPREP_STABLE = /^[\x20-\x7e]+$/;

/**
 * Returns `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` with standard base64, the form `pg_authid`
 * stores, so `CREATE ROLE ... PASSWORD '<verifier>'` sets the password without sending it.
 */
export function scramSha256Verifier(
  password: string,
  salt: Uint8Array,
  iterations: number = SCRAM_DEFAULT_ITERATIONS,
): string {
  if (!SASLPREP_STABLE.test(password)) {
    throw new Error("a SCRAM password must be non-empty printable ASCII, which SASLprep leaves unchanged");
  }
  if (salt.length === 0) throw new Error("a SCRAM salt must not be empty");
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error(`SCRAM iterations must be a positive integer, got ${iterations}`);
  }
  // Hi(password, salt, i) of RFC 5802 is PBKDF2 with HMAC-SHA-256 and one 32-byte block.
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  return `SCRAM-SHA-256$${iterations}:${base64(salt)}$${base64(storedKey)}:${base64(serverKey)}`;
}
