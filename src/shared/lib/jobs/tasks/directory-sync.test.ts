import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeycloakAdminClient, Query } from '@/shared/lib/keycloak/admin-client'
import { createKeycloakDirectory } from '@/shared/lib/keycloak/directory'
import { KeycloakNotFoundError, KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'
import { logger } from '@/shared/lib/logger'
import {
  createDirectorySyncTask,
  readSnapshotMember,
  type DirectoryMemberRow,
  type DirectoryRevocation,
  type DirectorySnapshotStore,
  type DirectorySyncChange,
  type DirectorySyncConfig,
  type SnapshotMember,
} from './directory-sync'

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const ROLE_CLIENT_UUID = '332b7468-9076-4a0b-af66-500a15e95788'
const ALICE = '00000000-0000-4000-8000-00000000a11c'
const GRACE = '00000000-0000-4000-8000-000000009ace'
const BOB = '00000000-0000-4000-8000-000000000b0b'
const DAVE = '00000000-0000-4000-8000-00000000da7e'
const ERIN = '00000000-0000-4000-8000-00000000e121'
const FRANK = '00000000-0000-4000-8000-00000000f4a2'
const CAROL = '00000000-0000-4000-8000-00000000ca20'
const DBA = 'group-dba'
const ANALYSTS = 'group-analysts'
const JUNIORS = 'group-juniors'

interface FakeUser {
  id: string
  username: string
  email?: string
  enabled: boolean
}

interface FakeGroup {
  members: Set<string>
  children: string[]
}

/**
 * An in-memory realm behind the two Admin API calls of the client, answering the paths that the directory reads as
 * Keycloak 26.8.1 does: the role-holder client libredb, its client roles with their direct users and groups, the
 * groups with their members and subgroups, and the users. An unknown user or role answers Keycloak's 404, which the
 * client turns into KeycloakNotFoundError.
 */
class FakeRealm implements KeycloakAdminClient {
  readonly users = new Map<string, FakeUser>()
  readonly roleUsers = new Map<string, Set<string>>()
  readonly roleGroups = new Map<string, Set<string>>()
  readonly groups = new Map<string, FakeGroup>()
  /** A request whose path matches one of these fails with the error, as an unreachable or broken Keycloak would. */
  readonly failures: Array<{ path: RegExp; error: Error }> = []

  constructor(roles: string[] = ['admin', 'user']) {
    for (const role of roles) {
      this.roleUsers.set(role, new Set())
      this.roleGroups.set(role, new Set())
    }
  }

  addUser(id: string, username: string, enabled = true): void {
    this.users.set(id, { id, username, email: `${username}@libredb.test`, enabled })
  }

  grant(role: string, id: string): void {
    this.roleUsers.get(role)!.add(id)
  }

  revoke(role: string, id: string): void {
    this.roleUsers.get(role)!.delete(id)
  }

  addGroup(id: string, members: string[], parent?: string): void {
    this.groups.set(id, { members: new Set(members), children: [] })
    if (parent !== undefined) this.groups.get(parent)!.children.push(id)
  }

  failOn(path: RegExp, error: Error): void {
    this.failures.push({ path, error })
  }

  private check(path: string): void {
    const failure = this.failures.find(candidate => candidate.path.test(path))
    if (failure) throw failure.error
  }

  private brief(id: string): Record<string, unknown> {
    const user = this.users.get(id)
    if (!user) throw new Error(`the fake realm lists the unknown user ${id}`)
    return { ...user }
  }

  private role(name: string, path: string): string {
    const role = decodeURIComponent(name)
    if (!this.roleUsers.has(role)) throw new KeycloakNotFoundError(`Keycloak Admin API GET ${path} answered 404`)
    return role
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    this.check(path)
    if (path === '/clients') {
      expect(query).toEqual({ clientId: 'libredb' })
      return [{ id: ROLE_CLIENT_UUID, clientId: 'libredb' }] as T
    }
    const user = /^\/users\/([^/]+)$/.exec(path)
    if (user) {
      const found = this.users.get(decodeURIComponent(user[1]))
      if (!found) throw new KeycloakNotFoundError(`Keycloak Admin API GET ${path} answered 404`)
      return { ...found } as T
    }
    throw new Error(`the fake realm has no GET ${path}`)
  }

  async getPaged<T>(path: string): Promise<T[]> {
    this.check(path)
    const roleUsers = new RegExp(`^/clients/${ROLE_CLIENT_UUID}/roles/([^/]+)/users$`).exec(path)
    if (roleUsers) return [...this.roleUsers.get(this.role(roleUsers[1], path))!].map(id => this.brief(id)) as T[]
    const roleGroups = new RegExp(`^/clients/${ROLE_CLIENT_UUID}/roles/([^/]+)/groups$`).exec(path)
    if (roleGroups) return [...this.roleGroups.get(this.role(roleGroups[1], path))!].map(id => ({ id })) as T[]
    const members = /^\/groups\/([^/]+)\/members$/.exec(path)
    if (members) return [...this.groups.get(decodeURIComponent(members[1]))!.members].map(id => this.brief(id)) as T[]
    const children = /^\/groups\/([^/]+)\/children$/.exec(path)
    if (children) return this.groups.get(decodeURIComponent(children[1]))!.children.map(id => ({ id })) as T[]
    throw new Error(`the fake realm has no paged GET ${path}`)
  }
}

/** The realm of tests/fixtures/keycloak/libredb-test-realm.json. */
function fixtureRealm(): FakeRealm {
  const realm = new FakeRealm()
  realm.addUser(ALICE, 'alice')
  realm.addUser(GRACE, 'grace')
  realm.addUser(BOB, 'bob')
  realm.addUser(DAVE, 'dave')
  realm.addUser(ERIN, 'erin')
  realm.addUser(FRANK, 'frank', false)
  realm.addUser(CAROL, 'carol')
  realm.grant('admin', ALICE)
  realm.addGroup(DBA, [GRACE])
  realm.roleGroups.get('admin')!.add(DBA)
  realm.grant('user', BOB)
  realm.grant('user', FRANK)
  realm.addGroup(ANALYSTS, [DAVE])
  realm.addGroup(JUNIORS, [ERIN], ANALYSTS)
  realm.roleGroups.get('user')!.add(ANALYSTS)
  return realm
}

/** A row of platform.directory_members, whose roles a hand edit can set to any array. */
interface StoredMember extends DirectoryMemberRow {
  firstSeenAt: Date
  lastSeenAt: Date
}

/** platform.directory_members and the revocations of platform.session_revocations, applied as one commit. */
class MemoryStore implements DirectorySnapshotStore {
  readonly members = new Map<string, StoredMember>()
  readonly revocations: DirectoryRevocation[] = []
  commits = 0

  /** Reads the rows as the store over Prisma does. */
  async read(): Promise<SnapshotMember[]> {
    return [...this.members.values()].map(({ firstSeenAt: _first, lastSeenAt: _last, ...row }) => readSnapshotMember(row))
  }

  async commit({ revocations, added, changed, removed, seenAt }: DirectorySyncChange): Promise<void> {
    for (const member of changed) {
      if (!this.members.has(member.subject)) throw new Error(`changed member ${member.subject} is not in the snapshot`)
    }
    this.commits += 1
    this.revocations.push(...revocations)
    for (const subject of removed) this.members.delete(subject)
    for (const member of changed) Object.assign(this.members.get(member.subject)!, member)
    for (const row of this.members.values()) row.lastSeenAt = seenAt
    for (const member of added) this.members.set(member.subject, { ...member, firstSeenAt: seenAt, lastSeenAt: seenAt })
  }

  /** The snapshot as subject: roles and enabled. */
  summary(): Record<string, { roles: Array<string | null>; enabled: boolean }> {
    return Object.fromEntries(
      [...this.members.values()].map(member => [member.subject, { roles: member.roles, enabled: member.enabled }]),
    )
  }
}

const SELF_HOSTED: DirectorySyncConfig = {
  DEPLOYMENT_MODE: 'self-hosted',
  PLATFORM_ADMIN_ROLE: 'admin',
  STUDIO_USER_ROLE: 'user',
  DIRECTORY_SYNC_INTERVAL_SEC: 60,
}

function syncTask(realm: FakeRealm, store: MemoryStore, config: DirectorySyncConfig = SELF_HOSTED) {
  return createDirectorySyncTask({
    config: () => config,
    directory: () => createKeycloakDirectory(realm),
    store,
    now: () => new Date('2026-10-15T12:00:00.000Z'),
  })
}

describe('directory sync', () => {
  let realm: FakeRealm
  let store: MemoryStore

  beforeEach(() => {
    vi.clearAllMocks()
    realm = fixtureRealm()
    store = new MemoryStore()
  })

  it('the first run and an unchanged second run yield nothing', async () => {
    const task = syncTask(realm, store)

    await task.run({ state: null })
    expect(store.revocations).toEqual([])
    // The first run seeds the snapshot with every member of both roles, directly or through a group or subgroup,
    // disabled members included, and carol, who holds neither role, is not a member.
    expect(store.summary()).toEqual({
      [ALICE]: { roles: ['admin'], enabled: true },
      [GRACE]: { roles: ['admin'], enabled: true },
      [BOB]: { roles: ['user'], enabled: true },
      [DAVE]: { roles: ['user'], enabled: true },
      [ERIN]: { roles: ['user'], enabled: true },
      [FRANK]: { roles: ['user'], enabled: false },
    })
    expect(store.members.get(BOB)).toMatchObject({ username: 'bob', email: 'bob@libredb.test' })

    await task.run({ state: null })
    expect(store.revocations).toEqual([])
    expect(store.commits).toBe(2)
  })

  it('a member moved from admin to user only yields one role-removed revocation', async () => {
    const task = syncTask(realm, store)
    await task.run({ state: null })

    realm.revoke('admin', ALICE)
    realm.grant('user', ALICE)
    await task.run({ state: null })

    expect(store.revocations).toEqual([{ subject: ALICE, reason: 'role-removed' }])
    expect(store.summary()[ALICE]).toEqual({ roles: ['user'], enabled: true })

    // Gaining a role ends no session: alice back in both roles yields nothing.
    realm.grant('admin', ALICE)
    await task.run({ state: null })
    expect(store.revocations).toHaveLength(1)
    expect(store.summary()[ALICE]).toEqual({ roles: ['admin', 'user'], enabled: true })
  })

  it('an enabled member that becomes disabled yields user-disabled', async () => {
    const task = syncTask(realm, store)
    await task.run({ state: null })

    realm.users.get(BOB)!.enabled = false
    await task.run({ state: null })
    expect(store.revocations).toEqual([{ subject: BOB, reason: 'user-disabled' }])
    expect(store.summary()[BOB]).toEqual({ roles: ['user'], enabled: false })

    // A member who stays disabled is not revoked again, and enabling one ends no session.
    await task.run({ state: null })
    realm.users.get(BOB)!.enabled = true
    realm.users.get(FRANK)!.enabled = true
    await task.run({ state: null })
    expect(store.revocations).toHaveLength(1)

    // A member who is disabled and loses a role in the same interval gets one revocation, user-disabled.
    realm.grant('admin', DAVE)
    await task.run({ state: null })
    realm.revoke('admin', DAVE)
    realm.users.get(DAVE)!.enabled = false
    await task.run({ state: null })
    expect(store.revocations.slice(1)).toEqual([{ subject: DAVE, reason: 'user-disabled' }])
  })

  it('a vanished member yields user-deleted on a Keycloak 404 and role-removed when the user still exists', async () => {
    const task = syncTask(realm, store)
    await task.run({ state: null })

    // Keycloak forgets bob altogether, and grace leaves group dba but keeps her account.
    realm.revoke('user', BOB)
    realm.users.delete(BOB)
    realm.groups.get(DBA)!.members.delete(GRACE)
    await task.run({ state: null })

    expect(store.revocations).toEqual(expect.arrayContaining([
      { subject: BOB, reason: 'user-deleted' },
      { subject: GRACE, reason: 'role-removed' },
    ]))
    expect(store.revocations).toHaveLength(2)
    expect(store.summary()).not.toHaveProperty(BOB)
    expect(store.summary()).not.toHaveProperty(GRACE)

    // A vanished member is never revoked twice, and one who comes back is a new member.
    await task.run({ state: null })
    realm.groups.get(DBA)!.members.add(GRACE)
    await task.run({ state: null })
    expect(store.revocations).toHaveLength(2)
    expect(store.summary()[GRACE]).toEqual({ roles: ['admin'], enabled: true })
  })

  it('a vanished member who is disabled yields user-disabled', async () => {
    const task = syncTask(realm, store)
    await task.run({ state: null })

    realm.revoke('admin', ALICE)
    realm.users.get(ALICE)!.enabled = false
    await task.run({ state: null })

    expect(store.revocations).toEqual([{ subject: ALICE, reason: 'user-disabled' }])
  })

  it('a stored member with a role other than admin and user is read as holding both, and losing one of them writes a role-removed revocation', async () => {
    const task = syncTask(realm, store)
    await task.run({ state: null })

    // Only directory sync writes the snapshot, so these rows are hand edits: alice's names a role that directory sync
    // never writes, and bob's names none. Neither account changed in Keycloak.
    store.members.get(ALICE)!.roles = ['auditor']
    store.members.get(BOB)!.roles = []
    await task.run({ state: null })

    // Each reads as a member that held both roles, so the role that the directory does not show writes a revocation
    // instead of failing the run: alice holds admin only, and bob user only.
    expect(store.revocations).toEqual(expect.arrayContaining([
      { subject: ALICE, reason: 'role-removed' },
      { subject: BOB, reason: 'role-removed' },
    ]))
    expect(store.revocations).toHaveLength(2)
    // The run rewrites both rows with the state it listed and logs each subject at error level.
    expect(store.summary()[ALICE]).toEqual({ roles: ['admin'], enabled: true })
    expect(store.summary()[BOB]).toEqual({ roles: ['user'], enabled: true })
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ subject: ALICE }))
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ subject: BOB }))

    // The rewritten rows read as they are stored, so the next run yields nothing.
    vi.mocked(logger.error).mockClear()
    await task.run({ state: null })
    expect(store.revocations).toHaveLength(2)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('a stored member it cannot read who still holds both roles yields no revocation, and the run rewrites the row', async () => {
    realm.grant('user', ALICE)
    const task = syncTask(realm, store)
    await task.run({ state: null })

    store.members.get(ALICE)!.roles = ['admin', 'auditor']
    await task.run({ state: null })

    // Read as holding both roles, alice lost none, and her row is rewritten although she reads as the run lists her.
    expect(store.revocations).toEqual([])
    expect(store.summary()[ALICE]).toEqual({ roles: ['admin', 'user'], enabled: true })
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ subject: ALICE }))
  })

  it('a member who still holds the role through a group yields nothing', async () => {
    // bob also belongs to analysts, and erin also holds user directly.
    realm.groups.get(ANALYSTS)!.members.add(BOB)
    realm.grant('user', ERIN)
    const task = syncTask(realm, store)
    await task.run({ state: null })

    // Each loses one path to user and keeps another: bob his direct role, erin hers, so she keeps it through the
    // subgroup juniors of analysts.
    realm.revoke('user', BOB)
    realm.revoke('user', ERIN)
    await task.run({ state: null })

    expect(store.revocations).toEqual([])
    expect(store.summary()[BOB]).toEqual({ roles: ['user'], enabled: true })
    expect(store.summary()[ERIN]).toEqual({ roles: ['user'], enabled: true })
  })

  it('an Admin API failure writes nothing', async () => {
    const task = syncTask(realm, store)
    await task.run({ state: null })
    const seeded = store.summary()

    // bob loses his role while the walk of the groups cannot be read.
    realm.revoke('user', BOB)
    realm.failOn(/^\/groups\/group-juniors\/members$/, new KeycloakUnavailableError('Keycloak Admin API GET answered 503'))
    await expect(task.run({ state: null })).rejects.toBeInstanceOf(KeycloakUnavailableError)
    expect(store.commits).toBe(1)
    expect(store.revocations).toEqual([])
    expect(store.summary()).toEqual(seeded)

    // The listings answer again, but the read of the vanished bob does not: a 404 without Keycloak's body is no deletion.
    realm.failures.length = 0
    realm.failOn(/^\/users\//, new KeycloakUnavailableError('Keycloak Admin API GET answered 404 without a Keycloak error body'))
    await expect(task.run({ state: null })).rejects.toBeInstanceOf(KeycloakUnavailableError)
    expect(store.commits).toBe(1)
    expect(store.revocations).toEqual([])

    // A 404 of a role listing means a missing role, never a deleted user, so the run fails instead of revoking.
    realm.failures.length = 0
    realm.failOn(/\/roles\/user\/users$/, new KeycloakNotFoundError('Keycloak Admin API GET answered 404'))
    await expect(task.run({ state: null })).rejects.toBeInstanceOf(KeycloakNotFoundError)
    expect(store.commits).toBe(1)
    expect(store.revocations).toEqual([])

    // Once Keycloak answers, the next run finds the transition that the failed runs left in place.
    realm.failures.length = 0
    await task.run({ state: null })
    expect(store.revocations).toEqual([{ subject: BOB, reason: 'role-removed' }])
  })

  it('lists the roles that PLATFORM_ADMIN_ROLE and STUDIO_USER_ROLE name and keeps them as admin and user', async () => {
    const renamed = new FakeRealm(['platform-admin', 'studio-user'])
    renamed.addUser(ALICE, 'alice')
    renamed.addUser(BOB, 'bob')
    renamed.grant('platform-admin', ALICE)
    renamed.grant('studio-user', BOB)
    const task = syncTask(renamed, store, {
      ...SELF_HOSTED,
      PLATFORM_ADMIN_ROLE: 'platform-admin',
      STUDIO_USER_ROLE: 'studio-user',
    })

    await task.run({ state: null })
    expect(store.summary()).toEqual({
      [ALICE]: { roles: ['admin'], enabled: true },
      [BOB]: { roles: ['user'], enabled: true },
    })

    renamed.revoke('platform-admin', ALICE)
    renamed.grant('studio-user', ALICE)
    await task.run({ state: null })
    expect(store.revocations).toEqual([{ subject: ALICE, reason: 'role-removed' }])

    // A role the realm lacks fails the run.
    const missing = syncTask(renamed, store, { ...SELF_HOSTED, STUDIO_USER_ROLE: 'nobody' })
    await expect(missing.run({ state: null })).rejects.toBeInstanceOf(KeycloakNotFoundError)
  })

  it('runs every DIRECTORY_SYNC_INTERVAL_SEC without jitter, and reads nothing in cloud mode', async () => {
    let config: DirectorySyncConfig = { ...SELF_HOSTED, DIRECTORY_SYNC_INTERVAL_SEC: 45 }
    const directory = vi.fn(() => createKeycloakDirectory(realm))
    const task = createDirectorySyncTask({ config: () => config, directory, store })

    expect(task.name).toBe('directory-sync')
    expect(task.intervalMs).toBe(45_000)
    // A role removal reaches Studio within one interval and one run, so the runs keep their exact cadence.
    expect(task.jitterRatio).toBe(0)

    // Cloud mode signs in without Keycloak, and no Studio reads its revocations.
    config = { ...SELF_HOSTED, DEPLOYMENT_MODE: 'cloud' }
    await task.run({ state: null })
    expect(directory).not.toHaveBeenCalled()
    expect(store.commits).toBe(0)
  })
})
