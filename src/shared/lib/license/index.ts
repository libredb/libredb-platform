/**
 * Offline license keys for self-hosted installs: the token format and its verification (token.ts), the public keys
 * compiled into this build (keys.ts), the license state with its seat limits (state.ts), and the closed vocabulary of
 * verification failures (errors.ts). None of it reads configuration, the clock or the network: callers pass the token,
 * the keys, the host and the time.
 */
export { LICENSE_ERROR_CODES, type LicenseErrorCode } from './errors'
export { LICENSE_KEYS } from './keys'
export {
  FREE_TIER_LIMITS,
  licenseStatus,
  type LicenseBoundaries,
  type LicenseState,
  type LicenseStatus,
  type SeatLimits,
} from './state'
export {
  licenseKeyring,
  verifyLicenseToken,
  type LicenseKey,
  type LicenseKeyring,
  type LicensePayload,
  type LicenseVerification,
  type VerifyLicenseOptions,
} from './token'
