/**
 * The license state of an install, computed from the outcome of verifying its token and from the clock on every read.
 *
 * A token that fails verification is `invalid`, and grants no seat. A valid license is `active` until 30 days before it
 * expires, then `expiring`, then `grace` for the 14 days after its expiry, while its seats still apply, and `expired`
 * from then on, when additions stop. No state ends any existing access: a state only decides whether a new seat may be
 * taken.
 */
import type { LicenseErrorCode } from './errors'
import type { LicensePayload, LicenseVerification } from './token'

/** The seats an install may use. */
export interface SeatLimits {
  readonly adminSeats: number
  readonly userSeats: number
}

const DAY_SECONDS = 86_400
/** Admins see a warning from this many days before the license expires. */
const WARNING_DAYS = 30
/** The license's seats still apply for this many days after it expires. */
const GRACE_DAYS = 14

/** Where the states of a valid license begin, in epoch seconds; each boundary belongs to the state it begins. */
export interface LicenseBoundaries {
  /** `expiring` begins, 30 days before expiry. */
  readonly expiringFrom: number
  /** `grace` begins: the expiry of the license. */
  readonly expiresAt: number
  /** `expired` begins, 14 days after expiry. */
  readonly graceEndsAt: number
}

export type LicenseStatus =
  // A token that fails verification grants no seat, so its status has no limits, unlike a valid license of 0 seats.
  | { readonly state: 'invalid'; readonly code: LicenseErrorCode }
  | {
      readonly state: 'active' | 'expiring' | 'grace' | 'expired'
      readonly license: LicensePayload
      /** The license's seats. In `expired` no addition is allowed, whatever these allow. */
      readonly limits: SeatLimits
      readonly boundaries: LicenseBoundaries
    }

export type LicenseState = LicenseStatus['state']

/**
 * The status of an install at `now`, from the outcome of verifying the install's token. A `now` that is not a valid
 * date throws a RangeError, so a broken clock never reads as a state.
 */
export function licenseStatus(verification: LicenseVerification, now: Date): LicenseStatus {
  const nowMs = now.getTime()
  if (Number.isNaN(nowMs)) throw new RangeError('The license state needs a valid date')
  if (!verification.ok) return { state: 'invalid', code: verification.code }

  const { license } = verification
  const boundaries: LicenseBoundaries = {
    expiringFrom: license.expiresAt - WARNING_DAYS * DAY_SECONDS,
    expiresAt: license.expiresAt,
    graceEndsAt: license.expiresAt + GRACE_DAYS * DAY_SECONDS,
  }
  const limits: SeatLimits = { adminSeats: license.adminSeats, userSeats: license.userSeats }
  return { state: validState(nowMs, boundaries), license, limits, boundaries }
}

// Milliseconds against whole seconds times 1000, so each state begins at the first millisecond of its boundary second.
function validState(nowMs: number, boundaries: LicenseBoundaries): 'active' | 'expiring' | 'grace' | 'expired' {
  if (nowMs < boundaries.expiringFrom * 1000) return 'active'
  if (nowMs < boundaries.expiresAt * 1000) return 'expiring'
  if (nowMs < boundaries.graceEndsAt * 1000) return 'grace'
  return 'expired'
}
