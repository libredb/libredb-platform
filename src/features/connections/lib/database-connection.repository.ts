import type { AdminActionChannel, DatabaseConnection, Prisma } from '@prisma/client'
import { db } from '@/shared/lib/db'
import { recordAdminAction } from '@/shared/lib/admin-actions'
import { NotFoundError } from '@/shared/lib/errors'
import type { LicenseStatus } from '@/shared/lib/license'
import { requireSeatsForNewConnection, requireSeatsForReactivation } from '@/shared/lib/license/seats'
import { envelopeKid } from '@/shared/lib/sealing/lsb1'
import { hostSummary, type ConnectionDefinition } from './engines'
import { deleteConnectionGrants } from './grant.repository'

// The connections of platform.database_connections, which bridge.connections_v1 publishes to Studio.
// Every finder takes the tenant of the session and skips deleted connections, and the sealed credentials never leave
// this module: callers see whether a write credential exists and the kid of each envelope.

/** A connection as Platform shows it: its columns without the sealed credentials. */
export interface DatabaseConnectionView {
  id: string
  name: string
  engine: string
  environment: string | null
  groupName: string | null
  color: string | null
  definition: ConnectionDefinition
  /** The address the definition points at, such as `db.internal:5432/orders`. */
  hostSummary: string
  mcpEnabled: boolean
  active: boolean
  hasWriteCredential: boolean
  /** The kid of the Studio key each credential is sealed to, which the key rotation lists credentials by. */
  readKid: string
  writeKid: string | null
  createdById: string
  createdAt: Date
  updatedAt: Date
}

/** A new connection, its credentials already sealed for its id, engine and definition. */
export interface NewDatabaseConnection {
  id: string
  name: string
  engine: string
  environment: string | null
  groupName: string | null
  color: string | null
  mcpEnabled: boolean
  definition: ConnectionDefinition
  readSecret: string
  writeSecret: string | null
}

/**
 * The columns an update changes. An update that writes a newly sealed credential also writes the engine and definition
 * the credential is sealed for, so the rebind trigger refuses the update if another one changed them in between.
 */
export interface DatabaseConnectionChanges {
  name?: string
  environment?: string | null
  groupName?: string | null
  color?: string | null
  mcpEnabled?: boolean
  active?: boolean
  engine?: string
  definition?: ConnectionDefinition
  readSecret?: string
  writeSecret?: string | null
}

/** The access levels whose credential an update sealed again. */
export type ResealedLevel = 'read' | 'write'

const TARGET_TYPE = 'connection'

function toView(row: DatabaseConnection): DatabaseConnectionView {
  const definition = row.definition as ConnectionDefinition
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    environment: row.environment,
    groupName: row.groupName,
    color: row.color,
    definition,
    hostSummary: hostSummary(definition),
    mcpEnabled: row.mcpEnabled,
    active: row.active,
    hasWriteCredential: row.writeSecret !== null,
    readKid: envelopeKid(row.readSecret),
    writeKid: row.writeSecret === null ? null : envelopeKid(row.writeSecret),
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** What the admin action log keeps of a connection: its public columns and the kids of its envelopes. */
function auditSnapshot(row: DatabaseConnection) {
  return {
    name: row.name,
    engine: row.engine,
    environment: row.environment,
    groupName: row.groupName,
    color: row.color,
    definition: row.definition as Prisma.InputJsonObject,
    mcpEnabled: row.mcpEnabled,
    active: row.active,
    readKid: envelopeKid(row.readSecret),
    writeKid: row.writeSecret === null ? null : envelopeKid(row.writeSecret),
  }
}

function findInTenant(client: Prisma.TransactionClient, tenantId: string, id: string) {
  return client.databaseConnection.findFirst({ where: { id, tenantId, deletedAt: null } })
}

export const DatabaseConnectionRepository = {
  /** The connections of a tenant that are not deleted, active or not, newest first. */
  async findAllByTenant(tenantId: string): Promise<DatabaseConnectionView[]> {
    const rows = await db.databaseConnection.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(toView)
  },

  /** A connection of the tenant that is not deleted; any other id answers NotFound, so ids of other tenants stay hidden. */
  async findById(tenantId: string, id: string): Promise<DatabaseConnectionView> {
    const row = await findInTenant(db, tenantId, id)
    if (!row) throw new NotFoundError('Connection')
    return toView(row)
  },

  /** The connections that count against the plan limit: every one that is not deleted. */
  countByTenant(tenantId: string): Promise<number> {
    return db.databaseConnection.count({ where: { tenantId, deletedAt: null } })
  },

  /**
   * Inserts a connection and its admin action in one transaction. `license` is the license status of the install, or
   * null in cloud mode: the seat gate refuses a new connection under a license that could not be verified or has
   * expired, and while more user seats are in use than the license allows, and locks the row of the tenant before
   * anything else.
   */
  create(
    tenantId: string,
    actorId: string,
    channel: AdminActionChannel,
    connection: NewDatabaseConnection,
    license: LicenseStatus | null,
  ): Promise<{ id: string }> {
    return db.$transaction(async (tx) => {
      await requireSeatsForNewConnection(tx, license, tenantId)
      const row = await tx.databaseConnection.create({
        data: {
          ...connection,
          definition: connection.definition as Prisma.InputJsonObject,
          tenantId,
          createdById: actorId,
        },
      })
      await recordAdminAction(tx, {
        actorId,
        channel,
        action: 'connection.create',
        targetType: TARGET_TYPE,
        targetId: row.id,
        before: null,
        after: auditSnapshot(row),
      })
      return { id: row.id }
    })
  },

  /**
   * Applies the changes to a connection of the tenant and records them in one transaction; NotFound otherwise.
   * `license` is the license status of the install, or null in cloud mode. Only a change that turns the connection active
   * again can take user seats, so only that one goes through the seat gate, which locks the row of the tenant before
   * anything else; every other change is allowed in every state. Returns the connection as the update left it.
   */
  async update(
    tenantId: string,
    id: string,
    actorId: string,
    channel: AdminActionChannel,
    changes: DatabaseConnectionChanges,
    resealed: readonly ResealedLevel[],
    license: LicenseStatus | null,
  ): Promise<DatabaseConnectionView> {
    return db.$transaction(async (tx) => {
      if (changes.active === true) await requireSeatsForReactivation(tx, license, tenantId, id)
      const before = await findInTenant(tx, tenantId, id)
      if (!before) throw new NotFoundError('Connection')
      const { definition, ...columns } = changes
      const after = await tx.databaseConnection.update({
        where: { id },
        data: {
          ...columns,
          ...(definition === undefined ? {} : { definition: definition as Prisma.InputJsonObject }),
        },
      })
      await recordAdminAction(tx, {
        actorId,
        channel,
        action: 'connection.update',
        targetType: TARGET_TYPE,
        targetId: id,
        before: auditSnapshot(before),
        after: { ...auditSnapshot(after), ...(resealed.length > 0 ? { resealed: [...resealed] } : {}) },
      })
      return toView(after)
    })
  },

  /**
   * Deletes a connection of the tenant softly: the row stays for its query events and admin actions, and
   * bridge.connections_v1 stops publishing it. Its grants are deleted in the same transaction, each recorded as
   * revoked. NotFound for a connection of another tenant or one already deleted.
   */
  async softDelete(tenantId: string, id: string, actorId: string, channel: AdminActionChannel): Promise<void> {
    await db.$transaction(async (tx) => {
      const before = await findInTenant(tx, tenantId, id)
      if (!before) throw new NotFoundError('Connection')
      await tx.databaseConnection.update({ where: { id }, data: { deletedAt: new Date(), active: false } })
      await recordAdminAction(tx, {
        actorId,
        channel,
        action: 'connection.delete',
        targetType: TARGET_TYPE,
        targetId: id,
        before: auditSnapshot(before),
        after: null,
      })
      await deleteConnectionGrants(tx, id, actorId, channel)
    })
  },
}
