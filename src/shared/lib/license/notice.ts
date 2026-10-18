/**
 * What the dashboard tells the admins of a self-hosted install about its license: a state they should act on, and
 * seats in use beyond what the license allows, which can follow a change of license or an upgrade from a version
 * without licensing. docs/deploy/platform-runtime.md describes both to operators.
 */
import type { LicenseErrorCode } from './errors'
import type { LicenseStatus } from './state'

/** Seats in use against the seats the license allows. */
export interface SeatUse {
  readonly inUse: number
  readonly allowed: number
}

/** A state of the license that an admin should act on, with its dates as ISO strings. */
export type LicenseAttention =
  | {
      readonly state: 'expiring' | 'grace' | 'expired'
      /** When the license expires, which begins its grace period. */
      readonly expiresAt: string
      /** When the grace period ends, after which no seat can be added. */
      readonly graceEndsAt: string
    }
  | { readonly state: 'invalid'; readonly code: LicenseErrorCode }

/** The notice of the dashboard banner, which holds only data that the page may show. */
export interface LicenseNotice {
  /** The state, or null in `active`. */
  readonly attention: LicenseAttention | null
  /** The user seats, when more are in use than the license allows. */
  readonly userSeatsOver: SeatUse | null
  /** The admin seats, when more are in use than the license allows. */
  readonly adminSeatsOver: SeatUse | null
}

/** The seats in use; the admin seats are null when Keycloak could not be asked which admin identities hold one. */
export interface SeatsInUse {
  readonly userSeats: number
  readonly adminSeats: number | null
}

function over(inUse: number | null, allowed: number): SeatUse | null {
  return inUse !== null && inUse > allowed ? { inUse, allowed } : null
}

function attentionOf(status: LicenseStatus): LicenseAttention | null {
  switch (status.state) {
    case 'active':
      return null
    case 'invalid':
      return { state: 'invalid', code: status.code }
    default:
      return {
        state: status.state,
        expiresAt: new Date(status.boundaries.expiresAt * 1000).toISOString(),
        graceEndsAt: new Date(status.boundaries.graceEndsAt * 1000).toISOString(),
      }
  }
}

/**
 * The notice for the install at this status and these seats in use, or null when nothing needs an admin's attention:
 * an active license with no more seats in use than it allows. Seats at their limit are not over it. An invalid license
 * grants no seat, so no seat in use is over a limit of it, and its notice names the failure alone.
 */
export function licenseNotice(status: LicenseStatus, inUse: SeatsInUse): LicenseNotice | null {
  const limits = status.state === 'invalid' ? null : status.limits
  const notice: LicenseNotice = {
    attention: attentionOf(status),
    userSeatsOver: limits === null ? null : over(inUse.userSeats, limits.userSeats),
    adminSeatsOver: limits === null ? null : over(inUse.adminSeats, limits.adminSeats),
  }
  if (notice.attention === null && notice.userSeatsOver === null && notice.adminSeatsOver === null) return null
  return notice
}
