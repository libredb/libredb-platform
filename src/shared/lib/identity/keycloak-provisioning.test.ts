import { describe, expect, it, vi } from 'vitest'
import { fakeAdminDirectory, type KeycloakAccount } from '../../../../tests/license/admin-directory'
import { answerSeatStatement, locksTenant, statementText } from '../../../../tests/license/seat-statements'
import { ConfigError, LicenseLimitError } from '../errors'
import { KeycloakUnavailableError } from '../keycloak/errors'
import { licenseStatus, type LicensePayload, type LicenseStatus } from '../license'
import {
  admitKeycloakAdmin,
  provisionKeycloakUser,
  type AdminAdmission,
  type AdminAdmissionClient,
  type KeycloakProvisioningClient,
} from './keycloak-provisioning'

const ALICE_SUB = '00000000-0000-4000-8000-00000000a11c'
const FIRST_SIGN_IN = new Date('2026-10-15T08:00:00.000Z')
const SECOND_SIGN_IN = new Date('2026-10-15T09:30:00.000Z')

interface UserRow {
  id: string
  keycloakId: string | null
  email: string
  name: string | null
  lastLoginAt: Date | null
}

type Where = Partial<Pick<UserRow, 'id' | 'keycloakId'>>

// platform.users with Prisma's upsert: the row that matches every field of `where`, exactly as PostgreSQL compares
// text, is updated, and otherwise a row is created.
function fakeClient(rows: UserRow[]) {
  let created = 0
  const upsert = vi.fn(async (args: {
    where: Where
    create: Omit<UserRow, 'id'>
    update: Partial<UserRow>
    select?: Partial<Record<keyof UserRow, true>>
  }) => {
    const entries = Object.entries(args.where) as [keyof UserRow, unknown][]
    let row = rows.find(candidate => entries.every(([field, value]) => candidate[field] === value))
    if (row) {
      Object.assign(row, args.update)
    } else {
      created += 1
      row = { id: `user-${created}`, ...args.create }
      rows.push(row)
    }
    return { ...row }
  })
  return { upsert, client: { user: { upsert } } as unknown as KeycloakProvisioningClient }
}

describe('provisionKeycloakUser', () => {
  it('creates a user with keycloakId on the first sign-in', async () => {
    const rows: UserRow[] = []
    const { client } = fakeClient(rows)

    const user = await provisionKeycloakUser(
      client,
      { sub: ALICE_SUB, email: 'alice@libredb.test', name: 'Alice Admin' },
      FIRST_SIGN_IN,
    )

    expect(rows).toEqual([
      { id: 'user-1', keycloakId: ALICE_SUB, email: 'alice@libredb.test', name: 'Alice Admin', lastLoginAt: FIRST_SIGN_IN },
    ])
    expect(user).toMatchObject({ id: 'user-1', email: 'alice@libredb.test', name: 'Alice Admin' })
  })

  it('a changed email updates the same row', async () => {
    const rows: UserRow[] = []
    const { client } = fakeClient(rows)

    const first = await provisionKeycloakUser(client, { sub: ALICE_SUB, email: 'alice@libredb.test', name: 'Alice Admin' }, FIRST_SIGN_IN)
    const second = await provisionKeycloakUser(
      client,
      { sub: ALICE_SUB, email: 'alice.admin@libredb.test', name: 'Alice Example' },
      SECOND_SIGN_IN,
    )

    expect(second.id).toBe(first.id)
    expect(rows).toEqual([
      { id: first.id, keycloakId: ALICE_SUB, email: 'alice.admin@libredb.test', name: 'Alice Example', lastLoginAt: SECOND_SIGN_IN },
    ])
  })

  it('never matches an existing row by email', async () => {
    // A cloud password user and a user of another Keycloak account, both with alice's email address.
    const cloudUser: UserRow = { id: 'cloud-user', keycloakId: null, email: 'alice@libredb.test', name: 'Cloud Alice', lastLoginAt: null }
    const otherAccount: UserRow = {
      id: 'other-account',
      keycloakId: '00000000-0000-4000-8000-00000000ca20',
      email: 'alice@libredb.test',
      name: 'Other Alice',
      lastLoginAt: null,
    }
    const rows = [{ ...cloudUser }, { ...otherAccount }]
    const { client, upsert } = fakeClient(rows)

    const user = await provisionKeycloakUser(client, { sub: ALICE_SUB, email: 'alice@libredb.test', name: 'Alice Admin' }, FIRST_SIGN_IN)

    expect(user.id).not.toBe(cloudUser.id)
    expect(user.id).not.toBe(otherAccount.id)
    expect(rows.slice(0, 2)).toEqual([cloudUser, otherAccount])
    expect(rows).toHaveLength(3)
    for (const [args] of upsert.mock.calls) {
      expect(args.where).toEqual({ keycloakId: ALICE_SUB })
    }
  })

  it('records a missing name as null', async () => {
    const rows: UserRow[] = [
      { id: 'user-alice', keycloakId: ALICE_SUB, email: 'alice@libredb.test', name: 'Alice Admin', lastLoginAt: FIRST_SIGN_IN },
    ]
    const { client } = fakeClient(rows)

    await provisionKeycloakUser(client, { sub: ALICE_SUB, email: 'alice@libredb.test', name: null }, SECOND_SIGN_IN)

    expect(rows[0]).toMatchObject({ name: null, lastLoginAt: SECOND_SIGN_IN })
  })
})

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

/** The status of LICENSE with this many admin seats, active or expired. */
function valid(state: 'active' | 'expired', adminSeats: number): LicenseStatus {
  const now = state === 'active' ? new Date('2027-01-01T00:00:00Z') : new Date('2027-11-01T00:00:00Z')
  const status = licenseStatus({ ok: true, license: { ...LICENSE, adminSeats } }, now)
  if (status.state !== state) throw new Error(`${now.toISOString()} is not in state ${state}`)
  return status
}

// A license of 1 admin seat, and a token that fails verification, which grants no seat.
const ONE_ADMIN_SEAT = valid('active', 1)
const INVALID = licenseStatus({ ok: false, code: 'LICENSE_UNKNOWN_KID' }, new Date('2027-01-01T00:00:00Z'))

// zoe, an admin of the realm, signs in for the first time.
const ZOE = { sub: 'kc-zoe', email: 'zoe@libredb.test', name: 'Zoe Admin' }

// The realm: alice and zoe are admins, frank's account is disabled, and carol's admin role was removed.
const REALM: Record<string, KeycloakAccount> = {
  'kc-alice': { enabled: true, roles: ['admin'] },
  'kc-zoe': { enabled: true, roles: ['admin'] },
  'kc-frank': { enabled: false, roles: ['admin'] },
  'kc-carol': { enabled: true, roles: ['user'] },
}

function userRow(name: string): UserRow {
  return { id: `user-${name}`, keycloakId: `kc-${name}`, email: `${name}@libredb.test`, name, lastLoginAt: null }
}

/**
 * platform.users and the install tenant behind the shared client and its transactions, with the upsert of fakeClient.
 * Every step is pushed onto `events` in order: each statement, each read of one user by its unique keycloakId, the
 * upsert, and the start and end of each transaction.
 * `beforeLock` runs as a transaction begins, as if another sign-in committed between the reads and the lock.
 */
function fakeDatabase(users: UserRow[], options: { tenant?: Array<{ id: string }>; beforeLock?: () => void } = {}) {
  const events: string[] = []
  const { upsert } = fakeClient(users)
  // Prisma's findUnique takes only unique fields in `where`, and users.keycloakId is one.
  const findUnique = vi.fn(async (args: { where: { keycloakId: string }; select: { id: true } }) => {
    events.push(`find user ${args.where.keycloakId}`)
    const row = users.find((candidate) => candidate.keycloakId === args.where.keycloakId)
    return row === undefined ? null : { id: row.id }
  })
  const rows = () => ({
    tenant: options.tenant ?? [{ id: TENANT }],
    databaseConnection: [],
    connectionGrant: [],
    user: users as unknown as Array<Record<string, unknown>>,
  })
  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = statementText(strings)
    events.push(locksTenant(text) ? 'lock tenant' : text.includes('FROM platform.users') ? 'read admin identities' : text)
    return answerSeatStatement(rows(), strings, values)
  }
  const tx = {
    $queryRaw,
    user: {
      upsert: async (args: Parameters<typeof upsert>[0]) => {
        events.push('upsert user')
        return upsert(args)
      },
    },
  }
  const client = {
    $queryRaw,
    user: { findUnique },
    $transaction: async (run: (transaction: typeof tx) => Promise<unknown>) => {
      events.push('begin')
      options.beforeLock?.()
      try {
        const result = await run(tx)
        events.push('commit')
        return result
      } catch (error) {
        events.push('rollback')
        throw error
      }
    },
  }
  return { client: client as unknown as AdminAdmissionClient, events, findUnique }
}

/** The admission of a sign-in under `license`, with a directory over `accounts` whose reads join `events`. */
function admissionOf(license: LicenseStatus | null, accounts: Record<string, KeycloakAccount> = REALM, events: string[] = []) {
  const directory = fakeAdminDirectory(accounts, events)
  const admission: AdminAdmission = {
    getLicenseStatus: vi.fn(() => license),
    getInstallTenant: vi.fn(async () => ({ id: TENANT })),
    directory: () => directory,
    adminRole: 'admin',
  }
  return { admission, directory }
}

/** 'admitted', or the code of the LicenseLimitError that refuses the sign-in. */
async function outcome(admitted: Promise<void>): Promise<string> {
  try {
    await admitted
    return 'admitted'
  } catch (error) {
    if (error instanceof LicenseLimitError) return error.code
    throw error
  }
}

describe('admitKeycloakAdmin', () => {
  it('lets an identity with a Platform user sign in in every state, without reading the license, locking or asking Keycloak', async () => {
    const licenses: Array<LicenseStatus | null> = [INVALID, valid('expired', 100), valid('active', 0), null]
    for (const license of licenses) {
      const users = [userRow('alice'), userRow('frank')]
      const { client, events, findUnique } = fakeDatabase(users)
      const { admission, directory } = admissionOf(license)

      expect(await outcome(admitKeycloakAdmin(client, { sub: 'kc-alice', email: 'alice@libredb.test', name: 'alice' }, admission))).toBe(
        'admitted',
      )
      // The sign-in reads its own user by the unique keycloakId, and never every user of a Keycloak account.
      expect(events).toEqual(['find user kc-alice'])
      expect(findUnique).toHaveBeenCalledExactlyOnceWith({ where: { keycloakId: 'kc-alice' }, select: { id: true } })
      expect(admission.getLicenseStatus).not.toHaveBeenCalled()
      expect(admission.getInstallTenant).not.toHaveBeenCalled()
      expect(directory.calls).toEqual([])
      // The jwt callback refreshes the user afterwards; the admission leaves it as it is.
      expect(users).toEqual([userRow('alice'), userRow('frank')])
    }

    // A license that cannot be read, a defect of the build, still lets an existing admin in.
    const { client } = fakeDatabase([userRow('alice')])
    const { admission } = admissionOf(ONE_ADMIN_SEAT)
    admission.getLicenseStatus = () => {
      throw new Error('License key 0 has a kid that is not derived from its public key')
    }
    expect(await outcome(admitKeycloakAdmin(client, { sub: 'kc-alice', email: 'alice@libredb.test', name: 'alice' }, admission))).toBe(
      'admitted',
    )
  })

  it('asks Keycloak about every admin identity before the transaction, and creates the new admin in the transaction that holds the lock', async () => {
    const signedInAt = new Date('2027-01-01T08:00:00Z')
    const users = [userRow('carol'), userRow('frank')]
    const { client, events } = fakeDatabase(users)
    const { admission } = admissionOf(ONE_ADMIN_SEAT, REALM, events)

    expect(await outcome(admitKeycloakAdmin(client, ZOE, admission, signedInAt))).toBe('admitted')

    // carol's role was removed and frank's account is disabled, so neither holds the license's one admin seat.
    const begin = events.indexOf('begin')
    expect(events.slice(0, 2)).toEqual(['find user kc-zoe', 'read admin identities'])
    expect(events.slice(2, begin).sort()).toEqual(['getEffectiveRoles kc-carol', 'getUser kc-carol', 'getUser kc-frank'])
    expect(events.slice(begin)).toEqual(['begin', 'lock tenant', 'read admin identities', 'upsert user', 'commit'])
    expect(users).toEqual([
      userRow('carol'),
      userRow('frank'),
      { id: 'user-1', keycloakId: 'kc-zoe', email: 'zoe@libredb.test', name: 'Zoe Admin', lastLoginAt: signedInAt },
    ])
  })

  it('refuses a new admin under an invalid license, when the admin seats in use reach the limit and after expiry, and writes no user', async () => {
    // alice holds an admin seat, and frank's disabled account holds none.
    const statuses: Array<[string, LicenseStatus, string]> = [
      ['invalid', INVALID, 'LICENSE_INVALID'],
      ['active at the limit', valid('active', 1), 'LICENSE_ADMIN_SEATS'],
      ['active below the limit', valid('active', 2), 'admitted'],
      ['expired', valid('expired', 100), 'LICENSE_EXPIRED'],
    ]
    for (const [name, license, expected] of statuses) {
      const users = [userRow('alice'), userRow('frank')]
      const { client, events } = fakeDatabase(users)
      const { admission, directory } = admissionOf(license)

      expect(await outcome(admitKeycloakAdmin(client, ZOE, admission)), name).toBe(expected)
      expect(users.map((row) => row.keycloakId), name).toEqual(
        expected === 'admitted' ? ['kc-alice', 'kc-frank', 'kc-zoe'] : ['kc-alice', 'kc-frank'],
      )
      if (expected !== 'admitted') expect(events.at(-1), name).toBe('rollback')
      // An invalid or expired license refuses every new admin whatever the seats, so neither Keycloak nor the admin
      // identities it would be asked about are read before the transaction.
      if (license.state === 'invalid' || license.state === 'expired') {
        expect(directory.calls, name).toEqual([])
        expect(events.slice(0, events.indexOf('begin')), name).toEqual(['find user kc-zoe'])
      }
    }
  })

  it('frees the seat of an admin whose account Keycloak disabled or deleted, or whose admin role it removed', async () => {
    const changes: Array<[string, Record<string, KeycloakAccount>, string]> = [
      ['alice is an enabled admin', REALM, 'LICENSE_ADMIN_SEATS'],
      ['alice is disabled', { ...REALM, 'kc-alice': { enabled: false, roles: ['admin'] } }, 'admitted'],
      ['alice lost the admin role', { ...REALM, 'kc-alice': { enabled: true, roles: ['user'] } }, 'admitted'],
      ['alice was deleted', { 'kc-zoe': REALM['kc-zoe'] }, 'admitted'],
    ]
    for (const [name, accounts, expected] of changes) {
      const { client } = fakeDatabase([userRow('alice')])
      const { admission } = admissionOf(ONE_ADMIN_SEAT, accounts)

      expect(await outcome(admitKeycloakAdmin(client, ZOE, admission)), name).toBe(expected)
    }
  })

  it('fails the sign-in when Keycloak cannot be read, before any transaction, instead of freeing a seat', async () => {
    const { client, events } = fakeDatabase([userRow('alice')])
    const { admission, directory } = admissionOf(ONE_ADMIN_SEAT)
    const unreachable = new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} answered 503')
    directory.getUser.mockRejectedValue(unreachable)

    await expect(admitKeycloakAdmin(client, ZOE, admission)).rejects.toBe(unreachable)
    expect(events).not.toContain('begin')
  })

  it('fails without asking Keycloak or writing a user when the install does not have exactly one tenant', async () => {
    const users = [userRow('alice')]
    const { client, events } = fakeDatabase(users)
    const { admission, directory } = admissionOf(ONE_ADMIN_SEAT)
    admission.getInstallTenant = async () => {
      throw new ConfigError('a self-hosted install needs exactly one tenant, and the database holds none')
    }

    await expect(admitKeycloakAdmin(client, ZOE, admission)).rejects.toThrow(ConfigError)
    expect(directory.calls).toEqual([])
    expect(events).toEqual(['find user kc-zoe'])
    expect(users).toEqual([userRow('alice')])
  })

  it('leaves the first sign-in to the jwt callback in cloud mode, where licensing does not apply', async () => {
    const users = [userRow('alice')]
    const { client, events } = fakeDatabase(users)
    const { admission, directory } = admissionOf(null)

    expect(await outcome(admitKeycloakAdmin(client, ZOE, admission))).toBe('admitted')
    expect(events).toEqual(['find user kc-zoe'])
    expect(directory.calls).toEqual([])
    expect(users).toEqual([userRow('alice')])
  })

  it('counts the user that another first sign-in created after Keycloak was asked, unless it is the same account', async () => {
    // Another first sign-in of zoe committed her user first: she takes no new seat and her user is refreshed.
    const own = [userRow('carol')]
    const first = fakeDatabase(own, { beforeLock: () => own.push(userRow('zoe')) })
    expect(await outcome(admitKeycloakAdmin(first.client, ZOE, admissionOf(ONE_ADMIN_SEAT).admission))).toBe('admitted')
    expect(own.map((row) => [row.keycloakId, row.name])).toEqual([
      ['kc-carol', 'carol'],
      ['kc-zoe', 'Zoe Admin'],
    ])

    // The first sign-in of hugo committed first and took the license's one admin seat.
    const other = [userRow('carol')]
    const second = fakeDatabase(other, { beforeLock: () => other.push(userRow('hugo')) })
    expect(await outcome(admitKeycloakAdmin(second.client, ZOE, admissionOf(ONE_ADMIN_SEAT).admission))).toBe(
      'LICENSE_ADMIN_SEATS',
    )
    expect(other.map((row) => row.keycloakId)).toEqual(['kc-carol', 'kc-hugo'])
  })
})
