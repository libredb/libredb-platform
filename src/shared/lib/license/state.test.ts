import { describe, expect, it } from 'vitest'
import { LICENSE_ERROR_CODES } from './errors'
import { licenseStatus, type LicenseState } from './state'
import type { LicensePayload, LicenseVerification } from './token'

// A license issued 2026-10-16 that expires 2027-10-16, with 2 admin and 25 user seats.
const LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-1',
  customer: 'Example Customer',
  adminSeats: 2,
  userSeats: 25,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
}
const VALID: LicenseVerification = { ok: true, license: LICENSE }

// Where each state begins, in epoch seconds: `expiring` 30 days (2 592 000 seconds) before expiry, `grace` at expiry
// and `expired` 14 days (1 209 600 seconds) after it.
const EXPIRING_FROM = LICENSE.expiresAt - 2_592_000
const GRACE_FROM = LICENSE.expiresAt
const EXPIRED_FROM = LICENSE.expiresAt + 1_209_600

const FREE_TIER = { adminSeats: 1, userSeats: 3 }

function at(seconds: number): Date {
  return new Date(seconds * 1000)
}

describe('licenseStatus', () => {
  it('is free, with 1 admin and 3 user seats, without a token', () => {
    for (const seconds of [0, LICENSE.issuedAt, EXPIRED_FROM]) {
      expect(licenseStatus(null, at(seconds))).toEqual({ state: 'free', limits: FREE_TIER })
    }
  })

  it('is invalid, with 1 admin and 3 user seats and the failure code, for a token that fails verification', () => {
    for (const code of LICENSE_ERROR_CODES) {
      expect(licenseStatus({ ok: false, code }, at(LICENSE.issuedAt)), code).toEqual({
        state: 'invalid',
        code,
        limits: FREE_TIER,
      })
    }
  })

  it('changes state exactly at each boundary, and not one second before', () => {
    const cases: Array<[string, number, LicenseState]> = [
      ['before the issue date', LICENSE.issuedAt - 86_400, 'active'],
      ['at the issue date', LICENSE.issuedAt, 'active'],
      ['one second before expiring', EXPIRING_FROM - 1, 'active'],
      ['at expiring', EXPIRING_FROM, 'expiring'],
      ['one second after expiring', EXPIRING_FROM + 1, 'expiring'],
      ['one second before expiry', GRACE_FROM - 1, 'expiring'],
      ['at expiry', GRACE_FROM, 'grace'],
      ['one second after expiry', GRACE_FROM + 1, 'grace'],
      ['one second before grace ends', EXPIRED_FROM - 1, 'grace'],
      ['when grace ends', EXPIRED_FROM, 'expired'],
      ['one second after grace ends', EXPIRED_FROM + 1, 'expired'],
      ['ten years after expiry', LICENSE.expiresAt + 10 * 365 * 86_400, 'expired'],
    ]
    for (const [name, seconds, state] of cases) {
      expect(licenseStatus(VALID, at(seconds)).state, name).toBe(state)
    }
  })

  it('starts each state at the first millisecond of its boundary second', () => {
    const cases: Array<[number, LicenseState, LicenseState]> = [
      [EXPIRING_FROM, 'active', 'expiring'],
      [GRACE_FROM, 'expiring', 'grace'],
      [EXPIRED_FROM, 'grace', 'expired'],
    ]
    for (const [boundary, before, from] of cases) {
      expect(licenseStatus(VALID, new Date(boundary * 1000 - 1)).state).toBe(before)
      expect(licenseStatus(VALID, new Date(boundary * 1000)).state).toBe(from)
    }
  })

  it("gives the license, its seats and its boundaries in every state of a valid license", () => {
    const states: LicenseState[] = []
    for (const seconds of [EXPIRING_FROM - 1, EXPIRING_FROM, GRACE_FROM, EXPIRED_FROM]) {
      const status = licenseStatus(VALID, at(seconds))
      states.push(status.state)
      expect(status).toEqual({
        state: status.state,
        license: LICENSE,
        limits: { adminSeats: 2, userSeats: 25 },
        boundaries: { expiringFrom: EXPIRING_FROM, expiresAt: GRACE_FROM, graceEndsAt: EXPIRED_FROM },
      })
    }
    expect(states).toEqual(['active', 'expiring', 'grace', 'expired'])
  })

  it('refuses a clock that gives an invalid date', () => {
    expect(() => licenseStatus(VALID, new Date(Number.NaN))).toThrow(RangeError)
    expect(() => licenseStatus(null, new Date('not a date'))).toThrow(RangeError)
  })
})
