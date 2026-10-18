import { licenseStatus, type LicenseStatus } from '../../src/shared/lib/license/state'
import type { LicensePayload } from '../../src/shared/lib/license/token'

// The license of a working self-hosted install, for the tests that need one whatever its state: every self-hosted
// install runs with a license, and this one has the seats of the license that LibreDB issues on request for 12 months.

/** A license issued 2026-10-16 that expires 2027-10-16, with 1 admin seat and 3 user seats. */
export const SMALL_LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-2026.0007',
  customer: 'Example Customer',
  adminSeats: 1,
  userSeats: 3,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
}

/** The status of SMALL_LICENSE on 2027-01-01, while it is active. */
export const SMALL_LICENSE_ACTIVE: LicenseStatus = licenseStatus(
  { ok: true, license: SMALL_LICENSE },
  new Date('2027-01-01T00:00:00Z'),
)
