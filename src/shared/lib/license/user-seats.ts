/**
 * The reads of the user seats of a self-hosted install: how many are in use, who holds them, which of some Keycloak
 * users hold one, and how many would be in use with a paused connection active again. A user seat is a distinct subject
 * that bridge.grants_v1 publishes: a Keycloak user with an unexpired grant on a connection that is active and not
 * deleted, admins included.
 *
 * The gates of seats.ts run these reads in the transaction of their write, after the lock of the install tenant. Read
 * with the shared client, as the License page and the grant picker do, they take no lock, so they show the seats as
 * they were a moment ago; only a gate, inside the transaction of its write, decides whether the write may take a seat.
 */
import type { Prisma } from '@prisma/client'

/** The database client of the reads: the shared client, or the transaction client of a gate. */
export type UserSeatClient = Pick<Prisma.TransactionClient, '$queryRaw'>

/** A user who holds a user seat. */
export interface UserSeatHolder {
  /** The Keycloak user id. */
  readonly subject: string
  /** The username and email the directory reported when the holder's latest grant was set. */
  readonly username: string
  readonly email: string | null
  /** The connections that bridge.grants_v1 publishes a grant of the holder on. */
  readonly connections: number
}

/** Holders by username: `max` of them from position `first`, which counts from 0. */
export interface HolderRange {
  readonly first: number
  readonly max: number
}

/** The user seats in use: the distinct subjects that bridge.grants_v1 publishes. */
export async function countUserSeatsInUse(client: UserSeatClient): Promise<number> {
  const [row] = await client.$queryRaw<{ seatsInUse: number }[]>`
    SELECT count(DISTINCT subject)::integer AS "seatsInUse" FROM bridge.grants_v1`
  return row.seatsInUse
}

/** The holders of user seats in `range`, by username, each with what their latest grant keeps of them. */
export function listUserSeatHolders(client: UserSeatClient, range: HolderRange): Promise<UserSeatHolder[]> {
  return client.$queryRaw<UserSeatHolder[]>`
    SELECT holder.subject, latest."subjectUsername" AS username, latest."subjectEmail" AS email, holder.connections
    FROM (
      SELECT subject, count(*)::integer AS connections FROM bridge.grants_v1 GROUP BY subject
    ) AS holder
    CROSS JOIN LATERAL (
      SELECT "subjectUsername", "subjectEmail" FROM platform.connection_grants
      WHERE subject = holder.subject AND "subjectKind" = 'user'
      ORDER BY "grantedAt" DESC, id DESC
      LIMIT 1
    ) AS latest
    ORDER BY latest."subjectUsername", holder.subject
    OFFSET ${range.first} LIMIT ${range.max}`
}

/** Those of `subjects` that hold a user seat. */
export async function userSeatHoldersAmong(client: UserSeatClient, subjects: readonly string[]): Promise<Set<string>> {
  if (subjects.length === 0) return new Set()
  const rows = await client.$queryRaw<{ subject: string }[]>`
    SELECT DISTINCT subject FROM bridge.grants_v1 WHERE subject = ANY(${[...subjects]}::text[])`
  return new Set(rows.map((row) => row.subject))
}

/**
 * The user seats that would be in use with the connection active: the subjects that bridge.grants_v1 publishes,
 * together with those of the connection's grants that it would publish then, which are the unexpired grants of users,
 * as the view selects them.
 */
export async function countUserSeatsWithConnectionActive(
  client: UserSeatClient,
  connectionId: string,
): Promise<number> {
  const [row] = await client.$queryRaw<{ seatsInUse: number }[]>`
    SELECT count(*)::integer AS "seatsInUse" FROM (
      SELECT subject FROM bridge.grants_v1
      UNION
      SELECT subject FROM platform.connection_grants
      WHERE "connectionId" = ${connectionId} AND "subjectKind" = 'user' AND ("expiresAt" IS NULL OR "expiresAt" > now())
    ) AS subjects`
  return row.seatsInUse
}
