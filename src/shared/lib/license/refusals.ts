/**
 * The refusals a page shows before a write, so an admin sees why the license would refuse it: the same verdicts as the
 * gates of seats.ts over seats counted without their lock, which refusals.test.ts checks against the gates. Only the
 * gate inside the write's transaction decides; a verdict here may be a moment old.
 */
import type { LicenseLimitCode } from '../errors'
import type { LicenseStatus } from './state'

/**
 * The code the gate of a new connection would refuse with at this many user seats in use, or null when it would allow
 * one: an expired license refuses every new connection, and so does an install with more user seats in use than its
 * license allows, while one at its limit may still add a connection, which takes no seat by itself. Without a license
 * status, which is cloud mode, nothing is refused.
 */
export function newConnectionRefusal(license: LicenseStatus | null, userSeatsInUse: number): LicenseLimitCode | null {
  if (license === null) return null
  if (license.state === 'expired') return 'LICENSE_EXPIRED'
  if (userSeatsInUse > license.limits.userSeats) return 'LICENSE_USER_SEATS'
  return null
}
