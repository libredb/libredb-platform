// Generated secrets of the secrets step.
import { randomBytes } from "node:crypto";

export const GENERATED_SECRET_BYTES = 32;

/**
 * Returns 32 random bytes as base64url without padding: 43 characters.
 * Every call is an independent draw, so no generated secret derives from another.
 * The secret store registers what it generates with the redactor; any other caller registers the value itself.
 */
export function generateSecret(): string {
  return randomBytes(GENERATED_SECRET_BYTES).toString("base64url");
}
