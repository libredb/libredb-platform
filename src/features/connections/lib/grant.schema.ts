/**
 * The inputs of the grant actions and the directory search behind the grant picker.
 * Nothing here runs only on the server, so the access panel can validate with the same schemas.
 */
import { z } from 'zod'
import type { DirectoryUser } from '@/shared/lib/keycloak/directory'

/** The levels of a grant: read opens a connection with its read credential, write with its write credential. */
export const GRANT_LEVELS = ['read', 'write'] as const

export type GrantLevelValue = (typeof GRANT_LEVELS)[number]

/** The users on one page of the directory search. */
export const DIRECTORY_PAGE_SIZE = 20

// Keycloak reads the position of a page's first user as a 32-bit integer, which this bound keeps it within.
const MAX_DIRECTORY_PAGE = 100_000

export const setConnectionGrantSchema = z.strictObject({
  connectionId: z.string().min(1),
  // The Keycloak user id, the OIDC sub of the issuer: opaque text of up to 512 characters, because an LDAP-federated
  // user without import has an id such as f:<component>:<username>. The directory refuses "." and "..", which the URL
  // parser would resolve to another Admin API path, so they never name a user.
  subject: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value !== '.' && value !== '..', 'cannot be "." or ".."'),
  level: z.enum(GRANT_LEVELS),
  // When the grant stops; the action refuses a time that is not in the future.
  expiresAt: z.coerce.date({ error: 'must be a date, or null for a grant that does not expire' }).nullable(),
})

export const revokeConnectionGrantSchema = z.strictObject({
  grantId: z.string().min(1),
})

export const searchDirectoryUsersSchema = z.strictObject({
  // The text the admin typed, matched anywhere in the username, first name, last name or email; empty lists every user.
  search: z.string().trim().max(255).default(''),
  // The page to show, from 1.
  page: z.number().int().min(1).max(MAX_DIRECTORY_PAGE).default(1),
})

export type SetConnectionGrantInput = z.infer<typeof setConnectionGrantSchema>
export type RevokeConnectionGrantInput = z.infer<typeof revokeConnectionGrantSchema>
export type SearchDirectoryUsersInput = z.infer<typeof searchDirectoryUsersSchema>

/** The mode a user's roles give in Studio: admin outranks user, and a user with neither cannot sign in. */
export type StudioRole = 'admin' | 'user'

/** The badge of a user's effective roles: the admin role makes a Studio admin, the user role a user. */
export function studioRoleOf(roles: string[], adminRole: string, userRole: string): StudioRole | null {
  if (roles.includes(adminRole)) return 'admin'
  if (roles.includes(userRole)) return 'user'
  return null
}

/** A Keycloak user as the grant picker shows it, with the badge of their effective Studio role. */
export interface DirectoryUserMatch extends DirectoryUser {
  studioRole: StudioRole | null
  /**
   * True when the license of a self-hosted install applies and the user holds no user seat, so a grant to them takes
   * one while its connection is active; false when they hold one or licensing does not apply.
   */
  needsSeat: boolean
}

/** One page of the directory search. */
export interface DirectoryUserPage {
  users: DirectoryUserMatch[]
  /** The page shown, from 1. */
  page: number
  /** The number of users that match the search on every page. */
  total: number
}

/**
 * What the Keycloak directory says of a grant's subject now: its live role badge and enabled flag, `missing` when
 * Keycloak no longer knows the id, and `unknown` when the directory could not be read.
 */
export type GrantSubjectStatus =
  | { status: 'present'; studioRole: StudioRole | null; enabled: boolean }
  | { status: 'missing' }
  | { status: 'unknown' }

/** A grant of a connection as the access panel shows it; the times are ISO strings. */
export interface ConnectionAccessGrant {
  id: string
  /** The Keycloak user id. */
  subject: string
  /** The username and email the directory reported when the grant was last set. */
  username: string
  email: string | null
  /** The level the grant asks for. */
  level: GrantLevelValue
  /** A write grant on a connection without a write credential, which Studio serves read only. */
  downgraded: boolean
  expiresAt: string | null
  /** The name, or the email, of the admin who last set the grant. */
  grantedBy: string
  grantedAt: string
  directory: GrantSubjectStatus
}

/**
 * Whether the panel could read the directory: `degraded` while the session lives on its grace, and
 * `unreachable` when Keycloak did not answer this read. Granting needs the directory, revoking does not.
 */
export type DirectoryAvailability = 'available' | 'degraded' | 'unreachable'

/** The grants of a connection with the directory status of their subjects. */
export interface ConnectionAccess {
  directory: DirectoryAvailability
  grants: ConnectionAccessGrant[]
}
