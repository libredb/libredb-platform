/**
 * The closed vocabulary of license verification failures, in the order token.ts checks for them. A failed verification
 * carries one of these codes and nothing else, so no log line or message built from it can hold the token or key
 * material.
 */
export const LICENSE_ERROR_CODES = [
  // Not `ldl1.<kid>.<payload>.<signature>` with a kid of 16 lowercase hex digits, a payload and signature in canonical
  // base64url, and a signature of 64 bytes.
  'LICENSE_MALFORMED',
  // The kid names no key compiled into this build.
  'LICENSE_UNKNOWN_KID',
  // The signature does not verify under the key the kid names.
  'LICENSE_BAD_SIGNATURE',
  // The signed payload is not a valid version 1 license.
  'LICENSE_PAYLOAD_INVALID',
  // The license lists hosts, and the host of AUTH_URL is not one of them.
  'LICENSE_HOST_MISMATCH',
] as const

export type LicenseErrorCode = (typeof LICENSE_ERROR_CODES)[number]
