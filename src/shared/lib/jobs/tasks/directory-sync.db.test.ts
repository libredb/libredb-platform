import { randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectSuperuser, fixtureUrl } from '../../../../../tests/db/connect'
import { listenBridge } from '../../../../../tests/db/listen'
import type { DirectoryUser, KeycloakDirectory } from '@/shared/lib/keycloak/directory'
import type { DirectorySyncConfig } from './directory-sync'

// Every subject of this file starts with this marker, so the cleanup removes exactly its revocations.
// No other test writes platform.directory_members, the snapshot that only directory sync keeps.
const MARKER = `directory-sync-${randomUUID().slice(0, 8)}`
const ADA = `${MARKER}:ada`
const BEN = `${MARKER}:ben`
const CY = `${MARKER}:cy`

const CONFIG: DirectorySyncConfig = {
  DEPLOYMENT_MODE: 'self-hosted',
  PLATFORM_ADMIN_ROLE: 'admin',
  STUDIO_USER_ROLE: 'user',
  DIRECTORY_SYNC_INTERVAL_SEC: 60,
}

function person(id: string, username: string, enabled = true): DirectoryUser {
  return { id, username, email: `${username}@libredb.test`, firstName: null, lastName: null, enabled }
}

/** The two reads of the Keycloak directory that directory sync makes, over members and users the test sets. */
class FakeDirectory implements Pick<KeycloakDirectory, 'listRoleMembers' | 'getUser'> {
  members: Record<string, DirectoryUser[]> = { admin: [], user: [] }
  users = new Map<string, DirectoryUser>()

  async listRoleMembers(role: string): Promise<DirectoryUser[]> {
    const members = this.members[role]
    if (members === undefined) throw new Error(`unexpected role ${role}`)
    return members.map(member => ({ ...member }))
  }

  async getUser(id: string): Promise<DirectoryUser | null> {
    const user = this.users.get(id)
    return user === undefined ? null : { ...user }
  }
}

describe('directory sync on PostgreSQL', () => {
  let db: typeof import('@/shared/lib/db').db
  let sync: typeof import('./directory-sync')
  let superuser: Client

  beforeAll(async () => {
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    sync = await import('./directory-sync')
    superuser = await connectSuperuser()
  })

  // Every test starts from an empty snapshot and none of this file's revocations.
  beforeEach(async () => {
    await superuser.query('DELETE FROM platform.session_revocations WHERE subject LIKE $1', [`${MARKER}:%`])
    await superuser.query('DELETE FROM platform.directory_members')
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.session_revocations WHERE subject LIKE $1', [`${MARKER}:%`])
    await superuser.query('DELETE FROM platform.directory_members')
    await superuser.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  async function revocations(): Promise<Array<Record<string, unknown>>> {
    const result = await superuser.query(
      `SELECT subject, reason, "createdById" FROM platform.session_revocations WHERE subject LIKE $1 ORDER BY subject`,
      [`${MARKER}:%`],
    )
    return result.rows
  }

  async function published(): Promise<Array<{ subject: string; revoked_before: Date }>> {
    const result = await superuser.query<{ subject: string; revoked_before: Date }>(
      `SELECT subject, revoked_before FROM bridge.session_revocations_v1 WHERE subject LIKE $1 ORDER BY subject`,
      [`${MARKER}:%`],
    )
    return result.rows
  }

  async function snapshot(): Promise<Array<Record<string, unknown>>> {
    const result = await superuser.query(
      `SELECT subject, username, email, roles, enabled, "firstSeenAt", "lastSeenAt"
         FROM platform.directory_members ORDER BY subject`,
    )
    return result.rows
  }

  it('revocations and the snapshot commit together and appear in bridge.session_revocations_v1', async () => {
    const directory = new FakeDirectory()
    const ada = person(ADA, 'ada')
    const ben = person(BEN, 'ben')
    const cy = person(CY, 'cy')
    directory.members.admin = [ada]
    directory.members.user = [ada, ben, cy]
    for (const user of [ada, ben, cy]) directory.users.set(user.id, user)

    const clock = { now: new Date('2026-10-15T10:00:00.000Z') }
    const task = sync.createDirectorySyncTask({
      config: () => CONFIG,
      directory: () => directory,
      store: sync.directorySnapshotStoreWith(db),
      now: () => clock.now,
    })
    const first = clock.now

    // The first run only seeds the snapshot.
    await task.run({ state: null })
    expect(await revocations()).toEqual([])
    expect(await snapshot()).toEqual([
      { subject: ADA, username: 'ada', email: 'ada@libredb.test', roles: ['admin', 'user'], enabled: true, firstSeenAt: first, lastSeenAt: first },
      { subject: BEN, username: 'ben', email: 'ben@libredb.test', roles: ['user'], enabled: true, firstSeenAt: first, lastSeenAt: first },
      { subject: CY, username: 'cy', email: 'cy@libredb.test', roles: ['user'], enabled: true, firstSeenAt: first, lastSeenAt: first },
    ])

    // ben loses user and keeps his account, and cy is disabled.
    directory.members.user = [ada, { ...cy, enabled: false }]
    const listener = await listenBridge()
    try {
      await listener.flush()
      clock.now = new Date('2026-10-15T10:01:00.000Z')
      const before = (await superuser.query<{ now: Date }>('SELECT now() AS now')).rows[0].now
      await task.run({ state: null })

      // Directory sync names no admin, and the revocations reach Studio's view.
      expect(await revocations()).toEqual([
        { subject: BEN, reason: 'role-removed', createdById: null },
        { subject: CY, reason: 'user-disabled', createdById: null },
      ])
      const rows = await published()
      expect(rows.map(row => row.subject)).toEqual([BEN, CY])
      for (const row of rows) expect(row.revoked_before.getTime()).toBeGreaterThanOrEqual(before.getTime())
      // Both revocations commit in one transaction, which PostgreSQL announces with one notification.
      expect(await listener.flush()).toEqual([{ v: 1, kind: 'revocations' }])

      expect(await snapshot()).toEqual([
        { subject: ADA, username: 'ada', email: 'ada@libredb.test', roles: ['admin', 'user'], enabled: true, firstSeenAt: first, lastSeenAt: clock.now },
        { subject: CY, username: 'cy', email: 'cy@libredb.test', roles: ['user'], enabled: false, firstSeenAt: first, lastSeenAt: clock.now },
      ])

      // ada is disabled while the snapshot cannot be written: her revocation rolls back with it.
      const seen = await snapshot()
      directory.members.admin = [{ ...ada, enabled: false }]
      directory.members.user = [{ ...ada, enabled: false }, { ...cy, enabled: false }]
      await superuser.query(`CREATE FUNCTION platform.refuse_directory_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'directory_members refuses writes in this test'; END $$`)
      await superuser.query(`CREATE TRIGGER refuse_directory_write BEFORE INSERT OR UPDATE OR DELETE ON platform.directory_members
        FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_directory_write()`)
      try {
        clock.now = new Date('2026-10-15T10:02:00.000Z')
        await expect(task.run({ state: null })).rejects.toThrow(/directory_members refuses writes in this test/)
      } finally {
        await superuser.query('DROP TRIGGER refuse_directory_write ON platform.directory_members')
        await superuser.query('DROP FUNCTION platform.refuse_directory_write()')
      }
      expect((await revocations()).map(row => row.subject)).toEqual([BEN, CY])
      expect(await snapshot()).toEqual(seen)
      expect(await listener.flush()).toEqual([])

      // The next run writes the transition that the failed run left in place.
      clock.now = new Date('2026-10-15T10:03:00.000Z')
      await task.run({ state: null })
      expect(await revocations()).toEqual([
        { subject: ADA, reason: 'user-disabled', createdById: null },
        { subject: BEN, reason: 'role-removed', createdById: null },
        { subject: CY, reason: 'user-disabled', createdById: null },
      ])
      expect((await published()).map(row => row.subject)).toEqual([ADA, BEN, CY])
      expect(await listener.flush()).toEqual([{ v: 1, kind: 'revocations' }])
    } finally {
      await listener.close()
    }
  })

  it('after a hand edit leaves a member with an unknown role, the next run commits its revocations and rewrites the row', async () => {
    const directory = new FakeDirectory()
    const ada = person(ADA, 'ada')
    const ben = person(BEN, 'ben')
    directory.members.admin = [ada]
    directory.members.user = [ben]
    for (const user of [ada, ben]) directory.users.set(user.id, user)

    const clock = { now: new Date('2026-10-15T11:00:00.000Z') }
    const task = sync.createDirectorySyncTask({
      config: () => CONFIG,
      directory: () => directory,
      store: sync.directorySnapshotStoreWith(db),
      now: () => clock.now,
    })
    const first = clock.now
    await task.run({ state: null })

    // Only directory sync writes the snapshot, so a role it never writes is a hand edit; ben loses user meanwhile.
    await superuser.query(`UPDATE platform.directory_members SET roles = '{auditor}' WHERE subject = $1`, [ADA])
    directory.members.user = []
    clock.now = new Date('2026-10-15T11:01:00.000Z')
    await task.run({ state: null })

    // ada reads as a member that held both roles, so the user role that the directory does not show her is revoked,
    // and ben's revocation commits with hers instead of waiting until someone repairs the table.
    expect(await revocations()).toEqual([
      { subject: ADA, reason: 'role-removed', createdById: null },
      { subject: BEN, reason: 'role-removed', createdById: null },
    ])
    expect((await published()).map(row => row.subject)).toEqual([ADA, BEN])
    // The run rewrote her row with the state it listed.
    expect(await snapshot()).toEqual([
      { subject: ADA, username: 'ada', email: 'ada@libredb.test', roles: ['admin'], enabled: true, firstSeenAt: first, lastSeenAt: clock.now },
    ])

    // The rewritten row reads as it is stored, so the next run revokes nothing.
    clock.now = new Date('2026-10-15T11:02:00.000Z')
    await task.run({ state: null })
    expect(await revocations()).toHaveLength(2)
  })

  it('a NULL among the roles of a member, which the typed Prisma read refuses, reads as both roles as well', async () => {
    const directory = new FakeDirectory()
    const cy = person(CY, 'cy')
    directory.members.user = [cy]
    directory.users.set(CY, cy)
    const task = sync.createDirectorySyncTask({
      config: () => CONFIG,
      directory: () => directory,
      store: sync.directorySnapshotStoreWith(db),
    })
    await task.run({ state: null })

    await superuser.query(`UPDATE platform.directory_members SET roles = '{user,NULL}' WHERE subject = $1`, [CY])
    await task.run({ state: null })

    // cy reads as a member that held both roles, so the admin role that the directory does not show him is revoked.
    expect(await revocations()).toEqual([{ subject: CY, reason: 'role-removed', createdById: null }])
    expect((await snapshot()).map(({ subject, roles }) => ({ subject, roles }))).toEqual([{ subject: CY, roles: ['user'] }])
  })
})
