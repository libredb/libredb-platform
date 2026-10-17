import type { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectPlatform, connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { createFreshDatabase } from '../../../../tests/db/fresh-database'
import { fakeAdminDirectory, type KeycloakAccount } from '../../../../tests/license/admin-directory'
import { ConfigError, LicenseLimitError } from '../errors'
import { licenseStatus, type LicensePayload, type LicenseStatus } from '../license'

// The admin seats of an install are the Platform users of Keycloak accounts, so this file reads a database of its own
// that no other test writes to, and each test starts without users. Keycloak is the in-memory directory of
// tests/license/admin-directory.ts, which each test sets.
const DATABASE = 'libredb_admin_seats'
const TENANT = 'tenant-install'
const PLAN = 'plan-enterprise'

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

// Without a token: 1 admin seat.
const FREE = licenseStatus(null, new Date('2027-01-01T00:00:00Z'))

const ADMIN: KeycloakAccount = { enabled: true, roles: ['admin'] }

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

describe('the admin-seat gate of a first Keycloak sign-in on PostgreSQL', () => {
  let db: typeof import('@/shared/lib/db').db
  let admitKeycloakAdmin: typeof import('./keycloak-provisioning').admitKeycloakAdmin
  let provisionKeycloakUser: typeof import('./keycloak-provisioning').provisionKeycloakUser
  let buildAuthCallbacks: typeof import('./auth-callbacks').buildAuthCallbacks
  let superuser: Client
  // The Keycloak realm, keyed by user id.
  let realm: Record<string, KeycloakAccount>

  /** The admission of a sign-in under `license`, over the realm of the test. */
  function admissionOf(license: LicenseStatus | null) {
    return {
      getLicenseStatus: () => license,
      getInstallTenant: async () => ({ id: TENANT }),
      directory: () => fakeAdminDirectory(realm),
      adminRole: 'admin',
    }
  }

  /** A sign-in of the admin `name`, whose Keycloak id is kc-<name>, under `license`. */
  function admit(name: string, license: LicenseStatus | null) {
    return admitKeycloakAdmin(db, { sub: `kc-${name}`, email: `${name}@libredb.test`, name }, admissionOf(license))
  }

  /** The Auth.js callbacks of a self-hosted install under `license`, which write users as src/shared/lib/auth.ts wires them. */
  function callbacksOf(license: LicenseStatus | null) {
    return buildAuthCallbacks({
      deploymentMode: 'self-hosted',
      roleClaim: 'libredb_roles',
      adminRole: 'admin',
      admitKeycloakAdmin: (identity) => admitKeycloakAdmin(db, identity, admissionOf(license)),
      provisionKeycloakUser: (identity) => provisionKeycloakUser(db, identity),
      getInstallTenant: async () => ({ id: TENANT, name: 'Example Customer', slug: 'default' }),
      loadCredentialsAccess: async () => null,
      readTenantCookie: async () => undefined,
      // A first sign-in neither rechecks nor refreshes its session.
      keycloakDirectory: () => {
        throw new Error('A first sign-in reads no session directory')
      },
      refreshKeycloakSession: async () => {
        throw new Error('A first sign-in refreshes no Keycloak session')
      },
      sessionRecheck: { intervalSeconds: 300, graceSeconds: 900 },
      now: () => Date.now(),
    })
  }

  /** The Keycloak ids of the Platform users. */
  async function users(): Promise<string[]> {
    const { rows } = await superuser.query('SELECT "keycloakId" FROM platform.users ORDER BY "keycloakId"')
    return rows.map((row) => row.keycloakId)
  }

  /** Locks the row of the install tenant on its own connection until `release`, as another gated write would. */
  async function holdTenantRow() {
    const holder = await connectPlatform(DATABASE)
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM platform.tenants WHERE id = $1 FOR NO KEY UPDATE', [TENANT])
    let released = false
    return {
      /** Resolves once `count` backends of this database are blocked, which only the held row can do here. */
      async waiters(count: number): Promise<void> {
        const deadline = Date.now() + 5_000
        for (;;) {
          const waiting = await superuser.query(
            `SELECT count(*)::integer AS count FROM pg_stat_activity
             WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
          )
          if (waiting.rows[0].count >= count) return
          if (Date.now() > deadline) throw new Error(`${count} sign-ins did not wait for the install tenant row within 5 s`)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      },
      /** Ends the holder's transaction and connection; a second call does nothing. */
      async release(): Promise<void> {
        if (released) return
        released = true
        await holder.query('ROLLBACK')
        await holder.end()
      },
    }
  }

  beforeAll(async () => {
    await createFreshDatabase(DATABASE)
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform', DATABASE)}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    ;({ admitKeycloakAdmin, provisionKeycloakUser } = await import('./keycloak-provisioning'))
    ;({ buildAuthCallbacks } = await import('./auth-callbacks'))
    superuser = await connectSuperuser(DATABASE)
    await superuser.query(
      `INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, 'ENTERPRISE', 'Enterprise', now())`,
      [PLAN],
    )
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'Example Customer', 'default', $2, now())`,
      [TENANT, PLAN],
    )
  })

  beforeEach(async () => {
    await superuser.query('DELETE FROM platform.users')
    realm = {}
  })

  afterAll(async () => {
    await superuser.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('admits the first admin on the free tier and refuses the next new one, while an admin with a user signs in in every state', async () => {
    realm = { 'kc-alice': ADMIN, 'kc-zoe': ADMIN }
    expect(await outcome(admit('alice', FREE))).toBe('admitted')
    expect(await users()).toEqual(['kc-alice'])

    expect(await outcome(admit('zoe', FREE))).toBe('LICENSE_ADMIN_SEATS')
    expect(await outcome(admit('zoe', valid('expired', 100)))).toBe('LICENSE_EXPIRED')
    expect(await users()).toEqual(['kc-alice'])

    for (const license of [FREE, valid('expired', 100), valid('active', 0)]) {
      expect(await outcome(admit('alice', license))).toBe('admitted')
    }
    expect(await users()).toEqual(['kc-alice'])

    expect(await outcome(admit('zoe', valid('active', 2)))).toBe('admitted')
    expect(await users()).toEqual(['kc-alice', 'kc-zoe'])
  })

  it('frees the seat of an admin whose account Keycloak disabled or deleted, or whose admin role it removed', async () => {
    realm = { 'kc-alice': ADMIN, 'kc-bea': ADMIN, 'kc-cem': ADMIN, 'kc-dan': ADMIN }
    expect(await outcome(admit('alice', FREE))).toBe('admitted')

    // The free tier's one admin seat is held by the admin admitted last, until Keycloak frees it for the next one.
    const steps: Array<[string, string, KeycloakAccount | null]> = [
      ['bea', 'kc-alice', { enabled: false, roles: ['admin'] }],
      ['cem', 'kc-bea', { enabled: true, roles: ['user'] }],
      ['dan', 'kc-cem', null],
    ]
    for (const [next, holder, change] of steps) {
      expect(await outcome(admit(next, FREE)), next).toBe('LICENSE_ADMIN_SEATS')
      if (change === null) delete realm[holder]
      else realm[holder] = change
      expect(await outcome(admit(next, FREE)), next).toBe('admitted')
    }
    expect(await users()).toEqual(['kc-alice', 'kc-bea', 'kc-cem', 'kc-dan'])
  })

  it('waits for the row lock of the install tenant before it counts, and takes no lock for an admin with a user', async () => {
    realm = { 'kc-alice': ADMIN }
    const lock = await holdTenantRow()
    try {
      let settled = false
      const first = admit('alice', FREE).finally(() => {
        settled = true
      })
      await lock.waiters(1)
      expect(settled).toBe(false)
      await lock.release()
      expect(await outcome(first)).toBe('admitted')
    } finally {
      await lock.release()
    }

    // alice has a user now, so her next sign-in ends while the row is held.
    const again = await holdTenantRow()
    try {
      expect(await outcome(admit('alice', FREE))).toBe('admitted')
    } finally {
      await again.release()
    }
  })

  it('admits exactly one of two new admins who ask for the last admin seat at the same time', async () => {
    realm = { 'kc-alice': ADMIN, 'kc-bea': ADMIN, 'kc-cem': ADMIN }
    expect(await outcome(admit('alice', FREE))).toBe('admitted')
    const oneSeatLeft = valid('active', 2)

    // Both sign-ins wait for the held row, so neither counts the seats before the other one could have committed.
    const lock = await holdTenantRow()
    const race = Promise.allSettled([admit('bea', oneSeatLeft), admit('cem', oneSeatLeft)])
    try {
      await lock.waiters(2)
    } finally {
      await lock.release()
    }
    const results = await race

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toBeInstanceOf(LicenseLimitError)
    expect(refused.reason.code).toBe('LICENSE_ADMIN_SEATS')
    const admins = await users()
    expect(admins).toHaveLength(2)
    expect(admins[0]).toBe('kc-alice')
  })

  it('admits both of two first sign-ins of one account at the same time, with one user', async () => {
    realm = { 'kc-alice': ADMIN }

    const lock = await holdTenantRow()
    const race = Promise.allSettled([admit('alice', FREE), admit('alice', FREE)])
    try {
      await lock.waiters(2)
    } finally {
      await lock.release()
    }

    expect((await race).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(await users()).toEqual(['kc-alice'])
  })

  it('takes no admin seat for a first sign-in without a refresh token, which jwt fails before it writes anything', async () => {
    realm = { 'kc-alice': ADMIN, 'kc-zoe': ADMIN }
    // The Platform client in Keycloak has "Use refresh tokens" off, so the account of zoe's sign-in carries none.
    const account = { provider: 'keycloak', type: 'oidc', providerAccountId: 'kc-zoe', id_token: 'zoe-id-token' }
    const profile = { sub: 'kc-zoe', email: 'zoe@libredb.test', name: 'zoe', libredb_roles: ['admin'] }
    const { signIn, jwt } = callbacksOf(FREE)

    await expect(signIn({ user: {}, account, profile })).resolves.toBe(true)
    await expect(jwt({ token: {}, account, profile, trigger: 'signIn' })).rejects.toThrow(ConfigError)
    expect(await users()).toEqual([])

    // The free tier's one admin seat is still free.
    expect(await outcome(admit('alice', FREE))).toBe('admitted')
    expect(await users()).toEqual(['kc-alice'])
  })
})
