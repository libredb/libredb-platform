/**
 * The gates of the writes that could add a user to a self-hosted install. A user seat is a distinct subject that
 * bridge.grants_v1 publishes, as user-seats.ts reads it: a Keycloak user with an unexpired grant on a connection that
 * is active and not deleted, admins included. A disabled or role-less user keeps the seat while the grant stays in
 * effect, because enabling the account again in Keycloak restores the access without any Platform write.
 *
 * A gate runs first in the transaction of its write, and its first statement locks the row of the install tenant, which
 * every gated write shares, so two writes that would each take the last seat run one after the other and the second
 * one counts the first. The lock is FOR NO KEY UPDATE, which conflicts with itself but not with the key share lock of a
 * foreign key check, so an insert that references the tenant never waits for a gate. The caller makes every HTTP call,
 * such as a Keycloak lookup, before the transaction begins, so none runs while the lock is held. Without a license
 * status, which is cloud mode, a gate neither locks nor counts.
 *
 * No license state ends any access: a gate only refuses a grant that would give a subject without a user seat access
 * now, a new connection, or a connection turned active again. Changing a grant in effect, granting a seat holder
 * another connection, any grant on a paused connection, revoking a grant, and changing, deactivating or deleting a
 * connection stay allowed in every state.
 */
import type { Prisma } from '@prisma/client'
import { LicenseLimitError } from '../errors'
import type { LicenseStatus } from './state'
import { countUserSeatsInUse, countUserSeatsWithConnectionActive, userSeatHoldersAmong } from './user-seats'

/** The transaction client of a gated write. */
export type SeatClient = Pick<Prisma.TransactionClient, '$queryRaw'>

/**
 * Locks the row of the install tenant until the transaction ends, as every gated write does first, the first sign-in of
 * a new admin included (admin-seats.ts). Without that row nothing would keep two writes from taking the last seat, so a
 * missing row fails the write.
 */
export async function lockInstallTenant(tx: SeatClient, tenantId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM platform.tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`
  if (rows.length !== 1) throw new Error(`The install tenant ${tenantId} does not exist, so no seat can be counted`)
}

/** Whether the connection of the tenant is active, or null when it is deleted or the tenant has none with this id. */
async function connectionActive(tx: SeatClient, tenantId: string, connectionId: string): Promise<boolean | null> {
  const [connection] = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT active FROM platform.database_connections
    WHERE id = ${connectionId} AND "tenantId" = ${tenantId} AND "deletedAt" IS NULL`
  return connection === undefined ? null : connection.active
}

/**
 * The gate of a grant of the subject on the connection. The caller sets every grant with an expiry in the future, so a
 * grant gives its subject access now exactly when its connection is active.
 * A grant on a paused connection takes no seat, so it passes in every state at any level and expiry, and the gate of
 * the update that turns the connection active again counts it. The connection is read after the lock, so a
 * reactivation that commits first makes the grant one on an active connection.
 * On an active connection, a subject who holds a user seat may be granted at any level and expiry in every state, while
 * a subject who holds none would take a new seat, which an expired license refuses, and so does a license whose user
 * seats are all in use. A connection that the tenant has neither active nor paused, such as one deleted since the
 * caller found it, is gated as an active one.
 */
export async function requireSeatForGrant(
  tx: SeatClient,
  license: LicenseStatus | null,
  tenantId: string,
  connectionId: string,
  subject: string,
): Promise<void> {
  if (license === null) return
  await lockInstallTenant(tx, tenantId)
  if ((await connectionActive(tx, tenantId, connectionId)) === false) return
  if ((await userSeatHoldersAmong(tx, [subject])).has(subject)) return
  if (license.state === 'expired') throw new LicenseLimitError('LICENSE_EXPIRED')
  if ((await countUserSeatsInUse(tx)) >= license.limits.userSeats) throw new LicenseLimitError('LICENSE_USER_SEATS')
}

/**
 * The gate of a new connection, which takes no seat by itself: an expired license refuses it, and so does an install
 * that uses more user seats than its license allows, while an install at its limit may still add a connection.
 */
export async function requireSeatsForNewConnection(
  tx: SeatClient,
  license: LicenseStatus | null,
  tenantId: string,
): Promise<void> {
  if (license === null) return
  await lockInstallTenant(tx, tenantId)
  if (license.state === 'expired') throw new LicenseLimitError('LICENSE_EXPIRED')
  if ((await countUserSeatsInUse(tx)) > license.limits.userSeats) throw new LicenseLimitError('LICENSE_USER_SEATS')
}

/**
 * The gate of an update that turns a connection of the tenant active again, after which bridge.grants_v1 publishes its
 * unexpired grants: an expired license refuses it, and so does a license that allows fewer user seats than the subjects
 * published already together with the subjects of those grants. A connection that is active already, deleted, of
 * another tenant or unknown passes, because the update then takes no seat or answers NotFound.
 */
export async function requireSeatsForReactivation(
  tx: SeatClient,
  license: LicenseStatus | null,
  tenantId: string,
  connectionId: string,
): Promise<void> {
  if (license === null) return
  await lockInstallTenant(tx, tenantId)
  if ((await connectionActive(tx, tenantId, connectionId)) !== false) return
  if (license.state === 'expired') throw new LicenseLimitError('LICENSE_EXPIRED')
  if ((await countUserSeatsWithConnectionActive(tx, connectionId)) > license.limits.userSeats) {
    throw new LicenseLimitError('LICENSE_USER_SEATS')
  }
}
