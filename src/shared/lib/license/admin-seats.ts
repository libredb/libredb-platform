/**
 * The admin seats of a self-hosted install, and the gate of the first sign-in of a new admin. An admin seat is a
 * Platform user of a Keycloak account that Keycloak still reports as an enabled admin: the account exists, is enabled
 * and holds PLATFORM_ADMIN_ROLE by its effective roles, which are the checks of the session recheck. An admin whose
 * account Keycloak disabled or deleted, or whose admin role it removed, holds no seat.
 *
 * Keycloak answers over HTTP, so a sign-in asks it about every admin identity before its transaction begins, and no
 * HTTP call runs while the gate holds the lock of the install tenant that every gated write shares (seats.ts).
 *
 * No license state ends any access: the gate refuses only the first sign-in of an admin who has no Platform user yet,
 * while an admin who has one signs in in every state, a license that could not be verified included.
 */
import type { Prisma } from '@prisma/client'
import { LicenseLimitError } from '../errors'
import type { KeycloakDirectory } from '../keycloak/directory'
import { lockInstallTenant } from './seats'
import type { LicenseStatus } from './state'

/** The reads of the Keycloak directory that the admin seats make. */
export type AdminSeatDirectory = Pick<KeycloakDirectory, 'getUser' | 'getEffectiveRoles'>

/** The database client of the admin seats: the shared client before a transaction, and the transaction client in it. */
export type AdminSeatClient = Pick<Prisma.TransactionClient, '$queryRaw'>

/**
 * How Keycloak reports an admin identity. Only `admin` holds a seat: an account that lost the admin role
 * (`role-removed`), one that Keycloak `disabled`, and one that Keycloak no longer has (`missing`) hold none.
 */
export type AdminSeatState = 'admin' | 'role-removed' | 'disabled' | 'missing'

/** A Platform user of a Keycloak account, which each admin has from the first sign-in on. */
export interface AdminIdentity {
  /** users.id. */
  readonly userId: string
  /** The Keycloak user id, the `sub` of the admin's tokens. */
  readonly keycloakId: string
  readonly email: string
  readonly name: string | null
}

/** The admin seats of an install as an admin sees them. */
export interface AdminSeatUsage {
  /** The admin seats in use: the identities that Keycloak reports as `admin`. */
  readonly seatsInUse: number
  /** Every admin identity by email, with how Keycloak reports it. */
  readonly identities: ReadonlyArray<AdminIdentity & { readonly state: AdminSeatState }>
}

/** The Platform users of Keycloak accounts, by email: every admin identity that has signed in. */
export function adminIdentities(client: AdminSeatClient): Promise<AdminIdentity[]> {
  return client.$queryRaw<AdminIdentity[]>`
    SELECT id AS "userId", "keycloakId", email, name FROM platform.users
    WHERE "keycloakId" IS NOT NULL ORDER BY email, id`
}

/**
 * How Keycloak reports the account now, checked in the order of the session recheck. Only GET /users/{id} reads
 * Keycloak's own 404 as a missing account, and any failure of a read is thrown, so no account that Keycloak could not
 * report frees a seat.
 */
export async function adminSeatState(
  directory: AdminSeatDirectory,
  adminRole: string,
  keycloakId: string,
): Promise<AdminSeatState> {
  const user = await directory.getUser(keycloakId)
  if (user === null) return 'missing'
  if (!user.enabled) return 'disabled'
  const roles = await directory.getEffectiveRoles(keycloakId)
  return roles.includes(adminRole) ? 'admin' : 'role-removed'
}

/** The Keycloak ids of those admin identities that hold no admin seat, as Keycloak reports them now. */
export async function identitiesWithoutAdminSeat(
  directory: AdminSeatDirectory,
  adminRole: string,
  keycloakIds: readonly string[],
): Promise<Set<string>> {
  // The admin client of the directory runs a few requests at once and queues the rest.
  const states = await Promise.all(keycloakIds.map((keycloakId) => adminSeatState(directory, adminRole, keycloakId)))
  return new Set(keycloakIds.filter((_, index) => states[index] !== 'admin'))
}

/**
 * The gate of the first sign-in of an admin identity without a Platform user, which runs first in the transaction
 * that creates that user. `withoutSeat` holds the admin identities that Keycloak reported, before the transaction
 * began, as holding no seat. Every other Platform user of a Keycloak account counts as a seat, a user created since
 * included, because only a first sign-in that passed this gate creates one.
 * An identity whose user exists by now, such as one whose other first sign-in committed first, takes no new seat and
 * passes in every state. Otherwise an invalid or expired license refuses the sign-in, and so does a license whose admin
 * seats are all in use. Without a license status, which is cloud mode, the gate neither locks nor counts.
 */
export async function requireAdminSeat(
  tx: AdminSeatClient,
  license: LicenseStatus | null,
  tenantId: string,
  keycloakId: string,
  withoutSeat: ReadonlySet<string>,
): Promise<void> {
  if (license === null) return
  await lockInstallTenant(tx, tenantId)
  const identities = await adminIdentities(tx)
  if (identities.some((identity) => identity.keycloakId === keycloakId)) return
  if (license.state === 'invalid') throw new LicenseLimitError('LICENSE_INVALID')
  if (license.state === 'expired') throw new LicenseLimitError('LICENSE_EXPIRED')
  const seatsInUse = identities.filter((identity) => !withoutSeat.has(identity.keycloakId)).length
  if (seatsInUse >= license.limits.adminSeats) throw new LicenseLimitError('LICENSE_ADMIN_SEATS')
}

/** The admin seats in use and every admin identity with how Keycloak reports it now, without any lock. */
export async function readAdminSeats(
  client: AdminSeatClient,
  directory: AdminSeatDirectory,
  adminRole: string,
): Promise<AdminSeatUsage> {
  const identities = await adminIdentities(client)
  const states = await Promise.all(
    identities.map((identity) => adminSeatState(directory, adminRole, identity.keycloakId)),
  )
  const reported = identities.map((identity, index) => ({ ...identity, state: states[index] }))
  return { seatsInUse: reported.filter((identity) => identity.state === 'admin').length, identities: reported }
}
