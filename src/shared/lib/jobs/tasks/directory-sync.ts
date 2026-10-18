import type { PrismaClient } from '@prisma/client'
import { insertSessionRevocation, type SessionRevocationReason } from '@/shared/lib/governance/session-revocations'
import type { DirectoryUser, KeycloakDirectory } from '@/shared/lib/keycloak/directory'
import { logger } from '@/shared/lib/logger'
import type { RuntimeConfig } from '@/shared/lib/runtime-config'
import type { ScheduledTask } from '../scheduler'

export const DIRECTORY_SYNC_TASK = 'directory-sync'

/** The LibreDB roles under their own names, whatever the realm calls them, in this order. */
export const LIBREDB_ROLES = ['admin', 'user'] as const

export type LibredbRole = (typeof LIBREDB_ROLES)[number]

/** A member of the LibreDB roles as directory sync lists it, and as platform.directory_members keeps it. */
export interface DirectoryMemberState {
  /** The Keycloak user id, the subject whose Studio sessions a revocation ends. */
  subject: string
  username: string
  email: string | null
  /** The roles the member holds directly or through a group or subgroup, in the order of LIBREDB_ROLES; never empty. */
  roles: LibredbRole[]
  enabled: boolean
}

/** A revocation that directory sync writes when a member loses a role, is disabled or is deleted. */
export interface DirectoryRevocation {
  subject: string
  reason: Exclude<SessionRevocationReason, 'admin'>
}

/** Everything one run writes, in one transaction. */
export interface DirectorySyncChange {
  revocations: DirectoryRevocation[]
  /** Members that the snapshot lacks. */
  added: DirectoryMemberState[]
  /** Members of the snapshot whose username, email, roles or enabled flag changed. */
  changed: DirectoryMemberState[]
  /** Subjects of the snapshot that neither role lists any more. */
  removed: string[]
  /** When the run listed the members, the lastSeenAt of every member it lists. */
  seenAt: Date
}

/** A row of platform.directory_members, whose roles a hand edit can set to any array, NULL elements included. */
export type DirectoryMemberRow = Omit<DirectoryMemberState, 'roles'> & { roles: Array<string | null> }

/** A member of the snapshot as readSnapshotMember() reads its row. */
export interface SnapshotMember extends DirectoryMemberState {
  /** The roles as stored, set only for a row that names no role, a NULL or a role other than admin and user. */
  unreadableRoles?: Array<string | null>
}

/** The snapshot in platform.directory_members and the revocations written with it. */
export interface DirectorySnapshotStore {
  /** The members that the last successful run listed, each row read through readSnapshotMember(). */
  read(): Promise<SnapshotMember[]>
  /** Inserts the revocations and applies the snapshot change in one transaction, so both commit or neither does. */
  commit(change: DirectorySyncChange): Promise<void>
}

function isLibredbRole(value: string | null): value is LibredbRole {
  return (LIBREDB_ROLES as readonly (string | null)[]).includes(value)
}

/**
 * Reads a row of the snapshot. Only directory sync writes the table, so a row that names no role, a NULL or
 * a role other than admin and user is a hand edit that the comparison must not guess about: it reads as a member that
 * held both roles, so the run revokes any role or account that the directory does not show for that subject and
 * rewrites the row, where failing the run would stop every revocation until someone repairs the table.
 */
export function readSnapshotMember(row: DirectoryMemberRow): SnapshotMember {
  if (row.roles.length > 0 && row.roles.every(isLibredbRole)) {
    return { ...row, roles: LIBREDB_ROLES.filter(role => row.roles.includes(role)) }
  }
  return { ...row, roles: [...LIBREDB_ROLES], unreadableRoles: row.roles }
}

/** The snapshot store over the Prisma client, which writes the revocations through insertSessionRevocation(). */
export function directorySnapshotStoreWith(
  client: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
): DirectorySnapshotStore {
  return {
    async read() {
      // A raw read, because the typed read of Prisma fails on a NULL among the roles, which a hand edit can store.
      const rows = await client.$queryRaw<DirectoryMemberRow[]>`
        SELECT subject, username, email, roles, enabled FROM platform.directory_members`
      return rows.map(readSnapshotMember)
    },

    async commit({ revocations, added, changed, removed, seenAt }) {
      await client.$transaction(async tx => {
        // Directory sync names no admin; the bridge_notify trigger tells Studio after the commit.
        for (const { subject, reason } of revocations) {
          await insertSessionRevocation(tx, { subject, reason, createdById: null })
        }
        if (removed.length > 0) {
          await tx.directoryMember.deleteMany({ where: { subject: { in: removed } } })
        }
        for (const { subject, username, email, roles, enabled } of changed) {
          await tx.directoryMember.update({ where: { subject }, data: { username, email, roles, enabled } })
        }
        // Every member left in the snapshot is listed now; the members created below are seen now too.
        await tx.directoryMember.updateMany({ data: { lastSeenAt: seenAt } })
        if (added.length > 0) {
          await tx.directoryMember.createMany({
            data: added.map(member => ({ ...member, firstSeenAt: seenAt, lastSeenAt: seenAt })),
          })
        }
      })
    },
  }
}

/** The variables of the validated runtime configuration that directory sync reads. */
export type DirectorySyncConfig = Pick<
  RuntimeConfig,
  'DEPLOYMENT_MODE' | 'PLATFORM_ADMIN_ROLE' | 'STUDIO_USER_ROLE' | 'DIRECTORY_SYNC_INTERVAL_SEC'
>

/** The reads of the Keycloak directory that directory sync makes. */
export type DirectoryReader = Pick<KeycloakDirectory, 'listRoleMembers' | 'getUser'>

export interface DirectorySyncOptions {
  /** The validated runtime configuration, read when the scheduler starts and at each run. */
  config: () => DirectorySyncConfig
  /**
   * The Keycloak directory, resolved at each run, so that a missing Keycloak configuration fails a run instead of the
   * import of the task registry.
   */
  directory: () => DirectoryReader
  store: DirectorySnapshotStore
  /** The clock of firstSeenAt and lastSeenAt; Studio compares revocations with the database clock. */
  now?: () => Date
}

// Merges the members of both roles by Keycloak id; a user who holds both appears in both listings.
function mergeMembers(listings: Record<LibredbRole, DirectoryUser[]>): Map<string, DirectoryMemberState> {
  const members = new Map<string, DirectoryMemberState>()
  for (const role of LIBREDB_ROLES) {
    for (const user of listings[role]) {
      const member = members.get(user.id)
      if (member) {
        member.roles.push(role)
      } else {
        members.set(user.id, { subject: user.id, username: user.username, email: user.email, roles: [role], enabled: user.enabled })
      }
    }
  }
  return members
}

/**
 * Why a member of the snapshot whom neither role lists any more loses its Studio sessions: user-deleted
 * when Keycloak has no such user, user-disabled when the user is disabled, and role-removed otherwise.
 */
function vanishedReason(account: DirectoryUser | null): DirectoryRevocation['reason'] {
  if (account === null) return 'user-deleted'
  return account.enabled ? 'role-removed' : 'user-disabled'
}

/**
 * Why a member of the snapshot whom a role still lists loses its Studio sessions, or null when they stand:
 * user-disabled when the account became disabled, and role-removed when it lost a role, even while it gained another.
 * One revocation ends every session, so a member who is disabled and loses a role in one interval gets one.
 */
function listedReason(before: DirectoryMemberState, after: DirectoryMemberState): DirectoryRevocation['reason'] | null {
  if (before.enabled && !after.enabled) return 'user-disabled'
  if (before.roles.some(role => !after.roles.includes(role))) return 'role-removed'
  return null
}

function differs(before: DirectoryMemberState, after: DirectoryMemberState): boolean {
  return (
    before.username !== after.username ||
    before.email !== after.email ||
    before.enabled !== after.enabled ||
    before.roles.join(' ') !== after.roles.join(' ')
  )
}

/**
 * Directory sync: every DIRECTORY_SYNC_INTERVAL_SEC, lists the members of PLATFORM_ADMIN_ROLE and
 * STUDIO_USER_ROLE, directly and through groups and subgroups, compares them with the snapshot of the last run, and
 * writes a session revocation for every member who lost a role, was disabled or was deleted, which ends that user's
 * Studio sessions.
 * The revocations and the new snapshot commit in one transaction. The first run only seeds the snapshot, because a
 * revocation needs a member of the snapshot, and a failed Admin API call fails the run before anything is written,
 * so the next run finds the same transitions. A snapshot row that it cannot read counts as a member that held both
 * roles, so the run revokes rather than stops, and the run rewrites that row (readSnapshotMember()).
 * Comparing snapshots misses a role granted and removed between two runs, before any run listed it: it writes no
 * revocation, so a Studio session signed in during that window lasts at most AUTH_SESSION_TTL_SECONDS.
 */
export function createDirectorySyncTask({
  config,
  directory,
  store,
  now = () => new Date(),
}: DirectorySyncOptions): ScheduledTask {
  return {
    name: DIRECTORY_SYNC_TASK,
    // Read when the scheduler starts and after each run, never when the registry loads, so that register() reports an
    // invalid DIRECTORY_SYNC_INTERVAL_SEC together with every other variable.
    get intervalMs() {
      return config().DIRECTORY_SYNC_INTERVAL_SEC * 1000
    },
    // No jitter: a lost role reaches Studio within one interval and one run, and the advisory lock already
    // keeps two replicas from running the task at once.
    jitterRatio: 0,
    async run() {
      const settings = config()
      if (settings.DEPLOYMENT_MODE !== 'self-hosted') {
        // Cloud mode signs in without Keycloak, and no Studio reads its revocations.
        logger.info('Directory sync skipped: it runs in self-hosted mode only', { mode: settings.DEPLOYMENT_MODE })
        return
      }
      const reader = directory()
      const [admins, users] = await Promise.all([
        reader.listRoleMembers(settings.PLATFORM_ADMIN_ROLE),
        reader.listRoleMembers(settings.STUDIO_USER_ROLE),
      ])
      const seenAt = now()
      const current = mergeMembers({ admin: admins, user: users })
      const previous = await store.read()

      // Only the read of one user tells a deleted user from one who lost the roles: Keycloak also answers 404 with its
      // JSON body for an unknown route, so a listing that answers 404 fails the run and never means a deletion.
      const vanished = previous.filter(member => !current.has(member.subject))
      const revocations = await Promise.all(
        vanished.map(async ({ subject }): Promise<DirectoryRevocation> => ({
          subject,
          reason: vanishedReason(await reader.getUser(subject)),
        })),
      )
      const known = new Set(previous.map(member => member.subject))
      const change: DirectorySyncChange = {
        revocations,
        added: [...current.values()].filter(member => !known.has(member.subject)),
        changed: [],
        removed: vanished.map(member => member.subject),
        seenAt,
      }
      for (const before of previous) {
        const after = current.get(before.subject)
        if (after === undefined) continue
        const reason = listedReason(before, after)
        if (reason !== null) change.revocations.push({ subject: before.subject, reason })
        // A row that the store could not read is rewritten even when it reads as the member that the run lists.
        if (before.unreadableRoles !== undefined || differs(before, after)) change.changed.push(after)
      }

      await store.commit(change)
      for (const { subject, unreadableRoles } of previous) {
        if (unreadableRoles === undefined) continue
        logger.error(
          'Directory sync counted a snapshot row with unreadable roles as a member that held both roles, and rewrote it',
          new Error(`platform.directory_members held unreadable roles for subject ${subject}`),
          { subject, roles: unreadableRoles },
        )
      }
      logger.info('Directory sync compared the LibreDB role members with its snapshot', {
        members: current.size,
        added: change.added.length,
        changed: change.changed.length,
        removed: change.removed.length,
        revoked: change.revocations,
      })
    },
  }
}
