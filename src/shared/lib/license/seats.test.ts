import { describe, expect, it } from 'vitest'
import { answerSeatStatement, locksTenant, statementText, type SeatTables } from '../../../../tests/license/seat-statements'
import { LicenseLimitError } from '../errors'
import { requireSeatForGrant, requireSeatsForNewConnection, requireSeatsForReactivation, type SeatClient } from './seats'
import { licenseStatus, type LicenseStatus } from './state'
import type { LicensePayload } from './token'

type Row = Record<string, unknown>

const TENANT = 'tenant-install'

// A license issued 2026-10-16 that expires 2027-10-16; each test sets its user seats.
const LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-2026.0042',
  customer: 'Example Customer',
  adminSeats: 2,
  userSeats: 25,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
}

// An instant in each state of LICENSE, which is expiring from 2027-09-16, in grace from 2027-10-16 and expired from
// 2027-10-30.
const AT = {
  active: new Date('2027-01-01T00:00:00Z'),
  expiring: new Date('2027-10-01T00:00:00Z'),
  grace: new Date('2027-10-20T00:00:00Z'),
  expired: new Date('2027-11-01T00:00:00Z'),
}

/** The status of LICENSE with this many user seats in a state of a valid license. */
function valid(state: keyof typeof AT, userSeats: number): LicenseStatus {
  const status = licenseStatus({ ok: true, license: { ...LICENSE, userSeats } }, AT[state])
  if (status.state !== state) throw new Error(`${AT[state].toISOString()} is not in state ${state}`)
  return status
}

// A token that fails verification, which grants no seat.
const INVALID = licenseStatus({ ok: false, code: 'LICENSE_BAD_SIGNATURE' }, AT.active)

function connection(id: string, overrides: Row = {}): Row {
  return { id, tenantId: TENANT, active: true, deletedAt: null, ...overrides }
}

function grant(connectionId: string, subject: string, expiresAt: Date | null = null): Row {
  return { connectionId, subjectKind: 'user', subject, expiresAt }
}

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000)

// bridge.grants_v1 publishes alice, bob and carol: 3 user seats in use. dave holds a grant on a paused connection, erin
// one that expired, and frank one on a deleted connection, so none of them holds a seat. The paused connection would
// add dave, and neither bob, who holds a seat, nor gina, whose grant expired.
function tables(): SeatTables {
  return {
    tenant: [{ id: TENANT }],
    databaseConnection: [
      connection('conn-orders'),
      connection('conn-paused', { active: false }),
      connection('conn-gone', { active: false, deletedAt: new Date('2026-10-02T00:00:00Z') }),
      connection('conn-foreign', { tenantId: 'tenant-other', active: false }),
    ],
    connectionGrant: [
      grant('conn-orders', 'alice'),
      grant('conn-orders', 'bob'),
      grant('conn-orders', 'carol', new Date(Date.now() + 60_000)),
      grant('conn-orders', 'erin', YESTERDAY),
      grant('conn-paused', 'dave'),
      grant('conn-paused', 'bob'),
      grant('conn-paused', 'gina', YESTERDAY),
      grant('conn-gone', 'frank'),
      grant('conn-foreign', 'hugo'),
    ],
  }
}

/** A transaction client over the tables that records the text and values of every statement it answers. */
function transaction(rows: SeatTables = tables()) {
  const statements: Array<{ text: string; values: unknown[] }> = []
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ text: statementText(strings), values })
      return answerSeatStatement(rows, strings, values)
    },
  }
  return { tx: tx as unknown as SeatClient, statements }
}

/** 'allowed', or the code of the LicenseLimitError the gate refuses with. */
async function outcome(gate: Promise<void>): Promise<string> {
  try {
    await gate
    return 'allowed'
  } catch (error) {
    if (error instanceof LicenseLimitError) return error.code
    throw error
  }
}

const GATES: Array<[string, (tx: SeatClient, license: LicenseStatus | null) => Promise<void>]> = [
  ['a grant', (tx, license) => requireSeatForGrant(tx, license, TENANT, 'conn-orders', 'zoe')],
  ['a grant on a paused connection', (tx, license) => requireSeatForGrant(tx, license, TENANT, 'conn-paused', 'zoe')],
  ['a new connection', (tx, license) => requireSeatsForNewConnection(tx, license, TENANT)],
  ['a reactivation', (tx, license) => requireSeatsForReactivation(tx, license, TENANT, 'conn-paused')],
]

describe('the seat gates', () => {
  it('make no statement and refuse nothing without a license status, which is cloud mode', async () => {
    // Far more subjects than any license of the tests allows.
    const crowded = tables()
    const many = Array.from({ length: 50 }, (_, index) => grant('conn-orders', `user-${index}`))
    const rows = { ...crowded, connectionGrant: [...crowded.connectionGrant, ...many] }
    for (const [write, gate] of GATES) {
      const { tx, statements } = transaction(rows)
      expect(await outcome(gate(tx, null)), write).toBe('allowed')
      expect(statements, write).toEqual([])
    }
  })

  it('each locks the row of the install tenant FOR NO KEY UPDATE with its first statement, and fails when that row does not exist', async () => {
    for (const [write, gate] of GATES) {
      const { tx, statements } = transaction()
      await gate(tx, valid('active', 100))
      // The lock conflicts with itself, so gated writes run one at a time, and not with the key share of a foreign key
      // check, so an insert that references the tenant never waits for a gate.
      expect(statements[0].text, write).toBe('SELECT id FROM platform.tenants WHERE id = ? FOR NO KEY UPDATE')
      expect(locksTenant(statements[0].text), write).toBe(true)
      expect(statements[0].values, write).toEqual([TENANT])
      expect(statements.filter((statement) => locksTenant(statement.text)), write).toHaveLength(1)
    }

    // Without the row nothing would keep two writes from taking the last seat, so the write fails instead.
    for (const [write, gate] of GATES) {
      const { tx, statements } = transaction({ ...tables(), tenant: [] })
      await expect(gate(tx, valid('active', 100)), write).rejects.toThrow(
        'The install tenant tenant-install does not exist, so no seat can be counted',
      )
      expect(statements, write).toHaveLength(1)
    }
  })

  it('refuse a grant on an active connection to a subject without a user seat under an invalid license, after expiry and when the seats in use reach the limit, and allow one to a subject who holds a seat in every state', async () => {
    const statuses: Array<[string, LicenseStatus]> = [
      ['invalid', INVALID],
      ['active below the limit', valid('active', 4)],
      ['active at the limit', valid('active', 3)],
      ['active above the limit', valid('active', 2)],
      ['expiring at the limit', valid('expiring', 3)],
      ['grace below the limit', valid('grace', 4)],
      ['grace at the limit', valid('grace', 3)],
      ['expired below the limit', valid('expired', 100)],
    ]
    const outcomes: Record<string, Record<string, string>> = {}
    for (const [name, license] of statuses) {
      outcomes[name] = {}
      // zoe holds no grant, and dave, erin and frank hold none that bridge.grants_v1 publishes; bob and carol hold a seat.
      for (const subject of ['zoe', 'dave', 'erin', 'frank', 'bob', 'carol']) {
        const gate = requireSeatForGrant(transaction().tx, license, TENANT, 'conn-orders', subject)
        outcomes[name][subject] = await outcome(gate)
      }
    }

    const newSubjects = (code: string) => ({ zoe: code, dave: code, erin: code, frank: code, bob: 'allowed', carol: 'allowed' })
    expect(outcomes).toEqual({
      invalid: newSubjects('LICENSE_INVALID'),
      'active below the limit': newSubjects('allowed'),
      'active at the limit': newSubjects('LICENSE_USER_SEATS'),
      'active above the limit': newSubjects('LICENSE_USER_SEATS'),
      'expiring at the limit': newSubjects('LICENSE_USER_SEATS'),
      'grace below the limit': newSubjects('allowed'),
      'grace at the limit': newSubjects('LICENSE_USER_SEATS'),
      'expired below the limit': newSubjects('LICENSE_EXPIRED'),
    })
  })

  it('allow a grant on a paused connection to a subject without a user seat, and a change of it, under an invalid license, at the limit and after expiry, and refuse the same grant on an active connection', async () => {
    const statuses: Array<[string, LicenseStatus, string]> = [
      ['invalid', INVALID, 'LICENSE_INVALID'],
      ['active above the limit', valid('active', 2), 'LICENSE_USER_SEATS'],
      ['grace at the limit', valid('grace', 3), 'LICENSE_USER_SEATS'],
      ['expired below the limit', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    for (const [name, license, refusal] of statuses) {
      // zoe holds no grant, and dave only his grant on conn-paused, which a second grant there changes. A grant on a
      // paused connection gives no access until the connection is active again, so it takes no seat.
      for (const subject of ['zoe', 'dave']) {
        const paused = await outcome(requireSeatForGrant(transaction().tx, license, TENANT, 'conn-paused', subject))
        expect(paused, `${name}: ${subject} on conn-paused`).toBe('allowed')
      }
      // On an active connection the same grants would take a seat. A connection that the tenant has neither active nor
      // paused, because it is deleted, of another tenant or unknown, is gated as an active one rather than let through.
      for (const connectionId of ['conn-orders', 'conn-gone', 'conn-foreign', 'conn-unknown']) {
        for (const subject of ['zoe', 'dave']) {
          const gated = await outcome(requireSeatForGrant(transaction().tx, license, TENANT, connectionId, subject))
          expect(gated, `${name}: ${subject} on ${connectionId}`).toBe(refusal)
        }
      }
    }
  })

  it('refuse a new connection under an invalid license, after expiry and when the seats in use are above the limit, and allow it at the limit', async () => {
    const statuses: Array<[string, LicenseStatus, string]> = [
      ['invalid', INVALID, 'LICENSE_INVALID'],
      ['active at the limit', valid('active', 3), 'allowed'],
      ['active above the limit', valid('active', 2), 'LICENSE_USER_SEATS'],
      ['expiring above the limit', valid('expiring', 2), 'LICENSE_USER_SEATS'],
      ['grace at the limit', valid('grace', 3), 'allowed'],
      ['expired below the limit', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    for (const [name, license, expected] of statuses) {
      expect(await outcome(requireSeatsForNewConnection(transaction().tx, license, TENANT)), name).toBe(expected)
    }

    // A fourth subject puts a license of 3 user seats above its limit.
    const over = tables()
    const rows = { ...over, connectionGrant: [...over.connectionGrant, grant('conn-orders', 'zoe')] }
    expect(await outcome(requireSeatsForNewConnection(transaction(rows).tx, valid('active', 3), TENANT))).toBe(
      'LICENSE_USER_SEATS',
    )
  })

  it('refuse turning a connection active again under an invalid license, after expiry and when its unexpired grants would bring the seats in use above the limit', async () => {
    // conn-paused adds dave to alice, bob and carol: 4 seats, while bob holds one already and gina's grant expired.
    const statuses: Array<[string, LicenseStatus, string]> = [
      ['invalid', INVALID, 'LICENSE_INVALID'],
      ['active with 4 seats', valid('active', 4), 'allowed'],
      ['active with 3 seats', valid('active', 3), 'LICENSE_USER_SEATS'],
      ['expiring with 3 seats', valid('expiring', 3), 'LICENSE_USER_SEATS'],
      ['grace with 4 seats', valid('grace', 4), 'allowed'],
      ['expired with 100 seats', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    for (const [name, license, expected] of statuses) {
      expect(await outcome(requireSeatsForReactivation(transaction().tx, license, TENANT, 'conn-paused')), name).toBe(
        expected,
      )
    }
  })

  it('refuse under an invalid license before they count any seat, whatever the seats in use, and let a grant on a paused connection pass', async () => {
    const expected: Record<string, string> = {
      'a grant': 'LICENSE_INVALID',
      'a grant on a paused connection': 'allowed',
      'a new connection': 'LICENSE_INVALID',
      'a reactivation': 'LICENSE_INVALID',
    }
    // No grant at all, so every limit of a valid license would allow these writes.
    const rows = { ...tables(), connectionGrant: [] }
    for (const [write, gate] of GATES) {
      const { tx, statements } = transaction(rows)
      expect(await outcome(gate(tx, INVALID)), write).toBe(expected[write])
      expect(locksTenant(statements[0].text), write).toBe(true)
      expect(statements.filter((statement) => statement.text.includes('count(')), write).toEqual([])
    }
  })

  it('allow a write to a connection that is active already, deleted, of another tenant or unknown, in every state', async () => {
    // None of these turns a connection active again: the write keeps the seats as they are, or answers NotFound.
    for (const connectionId of ['conn-orders', 'conn-gone', 'conn-foreign', 'conn-unknown']) {
      for (const license of [valid('expired', 0), valid('active', 0), INVALID]) {
        const { tx } = transaction()
        expect(await outcome(requireSeatsForReactivation(tx, license, TENANT, connectionId)), connectionId).toBe('allowed')
      }
    }
  })
})
