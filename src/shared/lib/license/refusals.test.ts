import { describe, expect, it } from 'vitest'
import { answerSeatStatement, type SeatTables } from '../../../../tests/license/seat-statements'
import { LicenseLimitError } from '../errors'
import { newConnectionRefusal } from './refusals'
import { requireSeatsForNewConnection, type SeatClient } from './seats'
import { licenseStatus, type LicenseStatus } from './state'
import type { LicensePayload } from './token'

const TENANT = 'tenant-install'

// A license for 2 admins and 3 users that expires 2027-10-16, in grace until 2027-10-30.
const LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-2026.0042',
  customer: 'Example Customer',
  adminSeats: 2,
  userSeats: 3,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
}

const STATUSES: Record<string, LicenseStatus> = {
  invalid: licenseStatus({ ok: false, code: 'LICENSE_UNKNOWN_KID' }, new Date('2027-01-01T00:00:00Z')),
  active: licenseStatus({ ok: true, license: LICENSE }, new Date('2027-01-01T00:00:00Z')),
  expiring: licenseStatus({ ok: true, license: LICENSE }, new Date('2027-10-01T00:00:00Z')),
  grace: licenseStatus({ ok: true, license: LICENSE }, new Date('2027-10-20T00:00:00Z')),
  expired: licenseStatus({ ok: true, license: LICENSE }, new Date('2027-11-01T00:00:00Z')),
}

/** An install whose one active connection grants `subjects` users, so bridge.grants_v1 publishes that many seats. */
function tablesWith(subjects: number): SeatTables {
  return {
    tenant: [{ id: TENANT }],
    databaseConnection: [{ id: 'connection-1', tenantId: TENANT, active: true, deletedAt: null }],
    connectionGrant: Array.from({ length: subjects }, (_, index) => ({
      connectionId: 'connection-1',
      subjectKind: 'user',
      subject: `subject-${index}`,
      expiresAt: null,
    })),
  }
}

/** The code the gate of a new connection refuses with over these tables, or null when it allows the connection. */
async function gateOutcome(status: LicenseStatus, tables: SeatTables): Promise<string | null> {
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => answerSeatStatement(tables, strings, values),
  } as unknown as SeatClient
  try {
    await requireSeatsForNewConnection(tx, status, TENANT)
    return null
  } catch (error) {
    if (error instanceof LicenseLimitError) return error.code
    throw error
  }
}

describe('newConnectionRefusal', () => {
  it('refuses as the gate of a new connection does, in every state and below, at and above the user-seat limit', async () => {
    for (const [name, status] of Object.entries(STATUSES)) {
      for (const subjects of [0, 2, 3, 4, 6]) {
        const expected = await gateOutcome(status, tablesWith(subjects))
        expect(newConnectionRefusal(status, subjects), `${name} with ${subjects} user seats in use`).toBe(expected)
      }
    }
  })

  it('refuses under an invalid license, after expiry and above the limit, and allows a connection at the limit', () => {
    expect(newConnectionRefusal(STATUSES.invalid, 0)).toBe('LICENSE_INVALID')
    expect(newConnectionRefusal(STATUSES.expired, 0)).toBe('LICENSE_EXPIRED')
    expect(newConnectionRefusal(STATUSES.active, 4)).toBe('LICENSE_USER_SEATS')
    expect(newConnectionRefusal(STATUSES.active, 3)).toBeNull()
    expect(newConnectionRefusal(STATUSES.grace, 3)).toBeNull()
  })

  it('never refuses without a license status, which is cloud mode', () => {
    expect(newConnectionRefusal(null, 1_000)).toBeNull()
  })
})
