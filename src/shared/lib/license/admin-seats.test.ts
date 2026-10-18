import { describe, expect, it } from 'vitest'
import { fakeAdminDirectory, type KeycloakAccount } from '../../../../tests/license/admin-directory'
import { answerSeatStatement, locksTenant, statementText, type SeatTables } from '../../../../tests/license/seat-statements'
import { LicenseLimitError } from '../errors'
import { KeycloakUnavailableError } from '../keycloak/errors'
import {
  adminIdentities,
  adminSeatState,
  identitiesWithoutAdminSeat,
  readAdminSeats,
  requireAdminSeat,
  type AdminSeatClient,
} from './admin-seats'
import { licenseStatus, type LicenseStatus } from './state'
import type { LicensePayload } from './token'

type Row = Record<string, unknown>

const TENANT = 'tenant-install'

// A license issued 2026-10-16 that expires 2027-10-16; each test sets its admin seats.
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

/** The status of LICENSE with this many admin seats in a state of a valid license. */
function valid(state: keyof typeof AT, adminSeats: number): LicenseStatus {
  const status = licenseStatus({ ok: true, license: { ...LICENSE, adminSeats } }, AT[state])
  if (status.state !== state) throw new Error(`${AT[state].toISOString()} is not in state ${state}`)
  return status
}

// A token that fails verification, which grants no seat.
const INVALID = licenseStatus({ ok: false, code: 'LICENSE_BAD_SIGNATURE' }, AT.active)

// The Keycloak realm: alice holds admin directly and grace through a group, so both have it among their effective
// roles; frank's account is disabled although it holds admin; carol's admin role was removed and she holds user; zoe is
// an admin who has not signed in yet. Keycloak has no account kc-gone any more.
const ACCOUNTS: Record<string, KeycloakAccount> = {
  'kc-alice': { enabled: true, roles: ['admin'] },
  'kc-grace': { enabled: true, roles: ['user', 'admin'] },
  'kc-frank': { enabled: false, roles: ['admin'] },
  'kc-carol': { enabled: true, roles: ['user'] },
  'kc-zoe': { enabled: true, roles: ['admin'] },
}

function user(name: string, keycloakId: string | null): Row {
  return { id: `user-${name}`, keycloakId, email: `${name}@libredb.test`, name: name[0].toUpperCase() + name.slice(1) }
}

// platform.users: alice, grace, frank, carol and gone signed in as admins before, and a cloud password user, who has no
// keycloakId, is no admin identity. Keycloak reports alice and grace as admins, so they hold the 2 admin seats in use.
function tables(extra: Row[] = []): SeatTables {
  return {
    tenant: [{ id: TENANT }],
    databaseConnection: [],
    connectionGrant: [],
    user: [
      user('grace', 'kc-grace'),
      user('alice', 'kc-alice'),
      user('frank', 'kc-frank'),
      user('carol', 'kc-carol'),
      user('gone', 'kc-gone'),
      user('cloud', null),
      ...extra,
    ],
  }
}

// What Keycloak reported, before the transaction, for the admin identities of tables(): no seat for frank, carol and gone.
const WITHOUT_SEAT: ReadonlySet<string> = new Set(['kc-frank', 'kc-carol', 'kc-gone'])

/** A database client over the tables that records the text and values of every statement it answers. */
function database(rows: SeatTables = tables()) {
  const statements: Array<{ text: string; values: unknown[] }> = []
  const client = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ text: statementText(strings), values })
      return answerSeatStatement(rows, strings, values)
    },
  }
  return { client: client as unknown as AdminSeatClient, statements }
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

describe('adminSeatState', () => {
  it('reports an enabled account that holds the admin role by its effective roles as admin, and one without it as role-removed', async () => {
    const directory = fakeAdminDirectory(ACCOUNTS)

    await expect(adminSeatState(directory, 'admin', 'kc-alice')).resolves.toBe('admin')
    await expect(adminSeatState(directory, 'admin', 'kc-grace')).resolves.toBe('admin')
    await expect(adminSeatState(directory, 'admin', 'kc-carol')).resolves.toBe('role-removed')
    expect(directory.calls).toEqual([
      'getUser kc-alice',
      'getEffectiveRoles kc-alice',
      'getUser kc-grace',
      'getEffectiveRoles kc-grace',
      'getUser kc-carol',
      'getEffectiveRoles kc-carol',
    ])
  })

  it('reports a disabled account and one that Keycloak does not have without reading their roles', async () => {
    const directory = fakeAdminDirectory(ACCOUNTS)

    await expect(adminSeatState(directory, 'admin', 'kc-frank')).resolves.toBe('disabled')
    await expect(adminSeatState(directory, 'admin', 'kc-gone')).resolves.toBe('missing')
    expect(directory.calls).toEqual(['getUser kc-frank', 'getUser kc-gone'])
  })

  it('reads the admin role that the configuration names', async () => {
    const directory = fakeAdminDirectory({ 'kc-dba': { enabled: true, roles: ['dba'] } })

    await expect(adminSeatState(directory, 'dba', 'kc-dba')).resolves.toBe('admin')
    await expect(adminSeatState(directory, 'admin', 'kc-dba')).resolves.toBe('role-removed')
  })

  it('throws a failure of Keycloak instead of reporting a state, so no account it could not read frees a seat', async () => {
    const unreachable = new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} answered 503')
    const users = fakeAdminDirectory(ACCOUNTS)
    users.getUser.mockRejectedValue(unreachable)
    const roles = fakeAdminDirectory(ACCOUNTS)
    roles.getEffectiveRoles.mockRejectedValue(unreachable)

    await expect(adminSeatState(users, 'admin', 'kc-alice')).rejects.toBe(unreachable)
    await expect(adminSeatState(roles, 'admin', 'kc-alice')).rejects.toBe(unreachable)
  })
})

describe('identitiesWithoutAdminSeat', () => {
  it('returns the identities that Keycloak reports as disabled, without the admin role or missing', async () => {
    const directory = fakeAdminDirectory(ACCOUNTS)

    await expect(
      identitiesWithoutAdminSeat(directory, 'admin', ['kc-alice', 'kc-frank', 'kc-grace', 'kc-carol', 'kc-gone']),
    ).resolves.toEqual(new Set(['kc-frank', 'kc-carol', 'kc-gone']))
  })

  it('asks Keycloak nothing when there is no identity to check', async () => {
    const directory = fakeAdminDirectory(ACCOUNTS)

    await expect(identitiesWithoutAdminSeat(directory, 'admin', [])).resolves.toEqual(new Set())
    expect(directory.calls).toEqual([])
  })
})

describe('adminIdentities', () => {
  it('lists the Platform users of Keycloak accounts by email, and no user without a keycloakId', async () => {
    const { client, statements } = database()

    const identities = await adminIdentities(client)

    expect(identities.map((identity) => identity.keycloakId)).toEqual(['kc-alice', 'kc-carol', 'kc-frank', 'kc-gone', 'kc-grace'])
    expect(identities[0]).toEqual({ userId: 'user-alice', keycloakId: 'kc-alice', email: 'alice@libredb.test', name: 'Alice' })
    expect(statements).toHaveLength(1)
  })
})

describe('requireAdminSeat', () => {
  it('makes no statement and refuses nothing without a license status, which is cloud mode', async () => {
    const { client, statements } = database()

    expect(await outcome(requireAdminSeat(client, null, TENANT, 'kc-zoe', new Set()))).toBe('allowed')
    expect(statements).toEqual([])
  })

  it('locks the row of the install tenant with its first statement, and fails when that row does not exist', async () => {
    const { client, statements } = database()
    await requireAdminSeat(client, valid('active', 100), TENANT, 'kc-zoe', WITHOUT_SEAT)
    expect(locksTenant(statements[0].text)).toBe(true)
    expect(statements[0].values).toEqual([TENANT])
    expect(statements.filter((statement) => locksTenant(statement.text))).toHaveLength(1)

    // Without the row nothing would keep two first sign-ins from taking the last seat, so the sign-in fails instead.
    const missing = database({ ...tables(), tenant: [] })
    await expect(requireAdminSeat(missing.client, valid('active', 100), TENANT, 'kc-zoe', WITHOUT_SEAT)).rejects.toThrow(
      'The install tenant tenant-install does not exist, so no seat can be counted',
    )
    expect(missing.statements).toHaveLength(1)
  })

  it('refuses a new admin under an invalid license, after expiry and when the admin seats in use reach the limit, and lets every identity with a Platform user pass in every state', async () => {
    const statuses: Array<[string, LicenseStatus]> = [
      ['invalid', INVALID],
      ['active below the limit', valid('active', 3)],
      ['active at the limit', valid('active', 2)],
      ['active above the limit', valid('active', 1)],
      ['expiring at the limit', valid('expiring', 2)],
      ['grace below the limit', valid('grace', 3)],
      ['grace at the limit', valid('grace', 2)],
      ['expired below the limit', valid('expired', 100)],
      ['a license of no admin seat', valid('active', 0)],
    ]
    const outcomes: Record<string, Record<string, string>> = {}
    for (const [name, license] of statuses) {
      outcomes[name] = {}
      // zoe has no Platform user; alice and grace hold a seat, and frank, carol and gone have a user but no seat.
      for (const keycloakId of ['kc-zoe', 'kc-alice', 'kc-grace', 'kc-frank', 'kc-carol', 'kc-gone']) {
        const { client } = database()
        outcomes[name][keycloakId] = await outcome(requireAdminSeat(client, license, TENANT, keycloakId, WITHOUT_SEAT))
      }
    }

    const newAdmin = (code: string) => ({
      'kc-zoe': code,
      'kc-alice': 'allowed',
      'kc-grace': 'allowed',
      'kc-frank': 'allowed',
      'kc-carol': 'allowed',
      'kc-gone': 'allowed',
    })
    expect(outcomes).toEqual({
      invalid: newAdmin('LICENSE_INVALID'),
      'active below the limit': newAdmin('allowed'),
      'active at the limit': newAdmin('LICENSE_ADMIN_SEATS'),
      'active above the limit': newAdmin('LICENSE_ADMIN_SEATS'),
      'expiring at the limit': newAdmin('LICENSE_ADMIN_SEATS'),
      'grace below the limit': newAdmin('allowed'),
      'grace at the limit': newAdmin('LICENSE_ADMIN_SEATS'),
      'expired below the limit': newAdmin('LICENSE_EXPIRED'),
      'a license of no admin seat': newAdmin('LICENSE_ADMIN_SEATS'),
    })
  })

  it('counts a user created after Keycloak was asked as a seat, and no identity that Keycloak reported without one', async () => {
    const threeSeats = valid('active', 3)

    // Another first sign-in created hugo's user after this one asked Keycloak: hugo takes the third seat.
    const later = database(tables([user('hugo', 'kc-hugo')]))
    expect(await outcome(requireAdminSeat(later.client, threeSeats, TENANT, 'kc-zoe', WITHOUT_SEAT))).toBe(
      'LICENSE_ADMIN_SEATS',
    )

    // Keycloak reported alice disabled as well, so only grace and hugo hold a seat.
    const freed = database(tables([user('hugo', 'kc-hugo')]))
    const withoutAlice = new Set([...WITHOUT_SEAT, 'kc-alice'])
    expect(await outcome(requireAdminSeat(freed.client, threeSeats, TENANT, 'kc-zoe', withoutAlice))).toBe('allowed')

    // Another first sign-in of zoe's own account created her user: she takes no new seat, so even expiry lets her pass.
    const own = database(tables([user('zoe', 'kc-zoe')]))
    expect(await outcome(requireAdminSeat(own.client, valid('expired', 0), TENANT, 'kc-zoe', WITHOUT_SEAT))).toBe('allowed')
  })
})

describe('readAdminSeats', () => {
  it('lists every admin identity by email with how Keycloak reports it, and counts the admins as the seats in use', async () => {
    const { client, statements } = database()
    const directory = fakeAdminDirectory(ACCOUNTS)

    const usage = await readAdminSeats(client, directory, 'admin')

    expect(usage).toEqual({
      seatsInUse: 2,
      identities: [
        { userId: 'user-alice', keycloakId: 'kc-alice', email: 'alice@libredb.test', name: 'Alice', state: 'admin' },
        { userId: 'user-carol', keycloakId: 'kc-carol', email: 'carol@libredb.test', name: 'Carol', state: 'role-removed' },
        { userId: 'user-frank', keycloakId: 'kc-frank', email: 'frank@libredb.test', name: 'Frank', state: 'disabled' },
        { userId: 'user-gone', keycloakId: 'kc-gone', email: 'gone@libredb.test', name: 'Gone', state: 'missing' },
        { userId: 'user-grace', keycloakId: 'kc-grace', email: 'grace@libredb.test', name: 'Grace', state: 'admin' },
      ],
    })
    // One read of platform.users and no lock: the License page holds no seat.
    expect(statements).toHaveLength(1)
    expect(locksTenant(statements[0].text)).toBe(false)
  })
})
