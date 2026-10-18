import { describe, expect, it } from 'vitest'
import { SMALL_LICENSE_ACTIVE } from '../../../../tests/license/statuses'
import { licenseNotice } from './notice'
import { licenseStatus, type LicenseStatus } from './state'
import type { LicensePayload } from './token'

// A license issued 2026-10-16 for 2 admins and 25 users that expires 2027-10-16: expiring from 2027-09-16, in grace
// from 2027-10-16 and expired from 2027-10-30.
const LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-2026.0042',
  customer: 'Example Customer',
  adminSeats: 2,
  userSeats: 25,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
}

const EXPIRES_AT = '2027-10-16T00:00:00.000Z'
const GRACE_ENDS_AT = '2027-10-30T00:00:00.000Z'

const AT = {
  active: new Date('2027-01-01T00:00:00Z'),
  expiring: new Date('2027-10-01T00:00:00Z'),
  grace: new Date('2027-10-20T00:00:00Z'),
  expired: new Date('2027-11-01T00:00:00Z'),
}

function valid(state: keyof typeof AT): LicenseStatus {
  const status = licenseStatus({ ok: true, license: LICENSE }, AT[state])
  if (status.state !== state) throw new Error(`${AT[state].toISOString()} is not in state ${state}`)
  return status
}

const INVALID = licenseStatus({ ok: false, code: 'LICENSE_BAD_SIGNATURE' }, AT.active)

/** Seats in use within every limit of LICENSE and of SMALL_LICENSE, which has 1 admin seat and 3 user seats. */
const WITHIN = { userSeats: 3, adminSeats: 1 }

describe('licenseNotice', () => {
  it('is null for an active license while the seats in use stay within its limits', () => {
    expect(licenseNotice(valid('active'), WITHIN)).toBeNull()
    expect(licenseNotice(valid('active'), { userSeats: 25, adminSeats: 2 })).toBeNull()
    expect(licenseNotice(SMALL_LICENSE_ACTIVE, WITHIN)).toBeNull()
    expect(licenseNotice(SMALL_LICENSE_ACTIVE, { userSeats: 0, adminSeats: 0 })).toBeNull()
  })

  it('names expiring, grace and expired with the expiry and the end of the grace period', () => {
    for (const state of ['expiring', 'grace', 'expired'] as const) {
      expect(licenseNotice(valid(state), WITHIN), state).toEqual({
        attention: { state, expiresAt: EXPIRES_AT, graceEndsAt: GRACE_ENDS_AT },
        userSeatsOver: null,
        adminSeatsOver: null,
      })
    }
  })

  it('names an invalid license with the code of the failed verification, and no seats over a limit, because it grants none', () => {
    for (const inUse of [WITHIN, { userSeats: 0, adminSeats: 0 }, { userSeats: 40, adminSeats: 5 }, { userSeats: 4, adminSeats: null }]) {
      expect(licenseNotice(INVALID, inUse)).toEqual({
        attention: { state: 'invalid', code: 'LICENSE_BAD_SIGNATURE' },
        userSeatsOver: null,
        adminSeatsOver: null,
      })
    }
  })

  it('reports the seats in use above the limits of the license, and never seats at their limit', () => {
    // A license of 1 admin and 3 users that replaced a larger one can leave the install over both.
    expect(licenseNotice(SMALL_LICENSE_ACTIVE, { userSeats: 4, adminSeats: 2 })).toEqual({
      attention: null,
      userSeatsOver: { inUse: 4, allowed: 3 },
      adminSeatsOver: { inUse: 2, allowed: 1 },
    })
    expect(licenseNotice(valid('active'), { userSeats: 26, adminSeats: 2 })).toEqual({
      attention: null,
      userSeatsOver: { inUse: 26, allowed: 25 },
      adminSeatsOver: null,
    })
    // The limits of the license still describe an expired one, which can be over them as well.
    expect(licenseNotice(valid('expired'), { userSeats: 30, adminSeats: 1 })).toEqual({
      attention: { state: 'expired', expiresAt: EXPIRES_AT, graceEndsAt: GRACE_ENDS_AT },
      userSeatsOver: { inUse: 30, allowed: 25 },
      adminSeatsOver: null,
    })
  })

  it('leaves the admin seats out when Keycloak could not be asked how many are in use', () => {
    expect(licenseNotice(SMALL_LICENSE_ACTIVE, { userSeats: 3, adminSeats: null })).toBeNull()
    expect(licenseNotice(SMALL_LICENSE_ACTIVE, { userSeats: 5, adminSeats: null })).toEqual({
      attention: null,
      userSeatsOver: { inUse: 5, allowed: 3 },
      adminSeatsOver: null,
    })
  })
})
