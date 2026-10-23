import type { AdminActionChannel, ConnectionGrant, GrantLevel, Prisma } from '@prisma/client'
import { db } from '@/shared/lib/db'
import { recordAdminAction } from '@/shared/lib/admin-actions'
import { NotFoundError } from '@/shared/lib/errors'
import type { LicenseStatus } from '@/shared/lib/license'
import { requireSeatForGrant } from '@/shared/lib/license/seats'
import { userSeatHoldersAmong } from '@/shared/lib/license/user-seats'

// The grants of platform.connection_grants, which bridge.grants_v1 publishes to Studio.
// A grant names one Keycloak user by id, the OIDC sub, and keeps the username and email the directory
// reported for display only. Every change writes its admin action in the same transaction, and the
// statement trigger of the table tells Studio to reload after the commit.

/** The subject kind of every grant until Keycloak groups become subjects. */
const USER_SUBJECT = 'user'

const TARGET_TYPE = 'grant'

/** A grant as the caller sets it: the connection of the session tenant and the directory snapshot of the subject. */
export interface GrantSetting {
  connectionId: string
  /** The Keycloak user id. */
  subject: string
  subjectUsername: string
  subjectEmail: string | null
  level: GrantLevel
  /** When the grant stops, or null for a grant that does not expire. */
  expiresAt: Date | null
}

/** What the admin action log keeps of a grant. */
function auditSnapshot(row: ConnectionGrant) {
  return {
    connectionId: row.connectionId,
    subjectKind: row.subjectKind,
    subject: row.subject,
    subjectUsername: row.subjectUsername,
    subjectEmail: row.subjectEmail,
    level: row.level,
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
  }
}

/**
 * Deletes every grant of the connection inside the caller's transaction, each recorded as revoked by the actor, so a
 * deleted connection takes its grants with it.
 */
export async function deleteConnectionGrants(
  tx: Prisma.TransactionClient,
  connectionId: string,
  actorId: string,
  channel: AdminActionChannel,
): Promise<void> {
  const grants = await tx.connectionGrant.findMany({
    where: { connectionId },
    orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
  })
  if (grants.length === 0) return
  await tx.connectionGrant.deleteMany({ where: { connectionId } })
  for (const grant of grants) {
    await recordAdminAction(tx, {
      actorId,
      channel,
      action: 'grant.revoke',
      targetType: TARGET_TYPE,
      targetId: grant.id,
      before: auditSnapshot(grant),
      after: null,
    })
  }
}

/** A grant with the Platform user who last set it, as the access panel lists it. */
export type GrantWithGranter = ConnectionGrant & { grantedBy: { name: string | null; email: string } }

export const ConnectionGrantRepository = {
  /** The grants of a connection of the tenant, by username; none for a connection of another tenant. */
  listForConnection(tenantId: string, connectionId: string): Promise<GrantWithGranter[]> {
    return db.connectionGrant.findMany({
      where: { connectionId, connection: { tenantId, deletedAt: null } },
      include: { grantedBy: { select: { name: true, email: true } } },
      orderBy: [{ subjectUsername: 'asc' }, { id: 'asc' }],
    })
  },

  /**
   * Those of the Keycloak users who hold a user seat, because bridge.grants_v1 publishes a grant of theirs. Read
   * without a lock, so the grant picker can mark the users whom a grant would give a new seat; the seat gate decides.
   */
  userSeatHolders(subjects: readonly string[]): Promise<Set<string>> {
    return userSeatHoldersAmong(db, subjects)
  },

  /**
   * Creates the grant of the subject on the connection, or replaces the one that exists, with its admin action in one
   * transaction. The caller has found the connection in the session tenant and checked the expiry against `now`.
   * The row holds the grant as it was last set: by the actor at `now`, so the expiry CHECK compares it with the same
   * time; the admin action log keeps every earlier state. A grant to the actor's own Keycloak id is recorded as a
   * self-grant.
   * `license` is the license status of the install at `now`, or null in cloud mode: a grant on an active connection
   * gives a subject without a user seat a new one only when the license allows it, a grant on a paused connection takes
   * no seat, and the seat gate locks the row of the session tenant before anything else.
   */
  set(
    tenantId: string,
    actorId: string,
    channel: AdminActionChannel,
    grant: GrantSetting,
    now: Date,
    license: LicenseStatus | null,
  ): Promise<{ id: string }> {
    return db.$transaction(async (tx) => {
      await requireSeatForGrant(tx, license, tenantId, grant.connectionId, grant.subject)
      const key = { connectionId: grant.connectionId, subjectKind: USER_SUBJECT, subject: grant.subject }
      const before = await tx.connectionGrant.findUnique({ where: { connectionId_subjectKind_subject: key } })
      const actor = await tx.user.findUnique({ where: { id: actorId }, select: { keycloakId: true } })
      const fields = {
        subjectUsername: grant.subjectUsername,
        subjectEmail: grant.subjectEmail,
        level: grant.level,
        expiresAt: grant.expiresAt,
        grantedById: actorId,
        grantedAt: now,
      }
      const row = await tx.connectionGrant.upsert({
        where: { connectionId_subjectKind_subject: key },
        create: { ...key, ...fields },
        update: fields,
      })
      await recordAdminAction(tx, {
        actorId,
        channel,
        action: before === null ? 'grant.create' : 'grant.update',
        targetType: TARGET_TYPE,
        targetId: row.id,
        before: before === null ? null : auditSnapshot(before),
        after: { ...auditSnapshot(row), selfGrant: actor?.keycloakId === grant.subject },
      })
      return { id: row.id }
    })
  },

  /**
   * Deletes a grant on a connection of the tenant that is not deleted, with its admin action in one transaction.
   * NotFound for a grant of another tenant and for one that another admin revoked first.
   */
  revoke(
    tenantId: string,
    grantId: string,
    actorId: string,
    channel: AdminActionChannel,
  ): Promise<{ connectionId: string }> {
    return db.$transaction(async (tx) => {
      const grant = await tx.connectionGrant.findFirst({
        where: { id: grantId, connection: { tenantId, deletedAt: null } },
      })
      if (!grant) throw new NotFoundError('Grant')
      const { count } = await tx.connectionGrant.deleteMany({ where: { id: grant.id } })
      if (count === 0) throw new NotFoundError('Grant')
      await recordAdminAction(tx, {
        actorId,
        channel,
        action: 'grant.revoke',
        targetType: TARGET_TYPE,
        targetId: grant.id,
        before: auditSnapshot(grant),
        after: null,
      })
      return { connectionId: grant.connectionId }
    })
  },
}
