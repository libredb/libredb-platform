import { getKeycloakDirectory, type DirectoryUser, type KeycloakDirectory } from '@/shared/lib/keycloak/directory'
import { KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'
import { getRuntimeConfig } from '@/shared/lib/runtime-config'
import { logger } from '@/shared/lib/logger'
import type { CurrentUser } from '@/shared/types'

/** The number of users on one page of the listing. */
export const STUDIO_USERS_PAGE_SIZE = 20

/** The LibreDB roles: admin is the role PLATFORM_ADMIN_ROLE names, user the one STUDIO_USER_ROLE names. */
export type StudioUserRole = 'admin' | 'user'

/** A member of the admin or user role, as the listing shows it. */
export interface StudioUser {
  /** The Keycloak user id: the subject of grants and session revocations. */
  id: string
  username: string
  email: string | null
  /** The first and last name, or null when Keycloak has neither. */
  name: string | null
  /** False for a user whom Keycloak does not let sign in. */
  enabled: boolean
  /** The roles the user holds directly or through a group, admin first. */
  roles: StudioUserRole[]
}

export interface StudioUsersQuery {
  /** Matches the username, the email or the name, without regard to case; empty matches every user. */
  search: string
  /** The page to show, from 1. */
  page: number
}

export interface StudioUsersPage {
  users: StudioUser[]
  /** The page shown, from 1: the last page when the query asked for one past it. */
  page: number
  /** The number of pages, at least 1. */
  pageCount: number
  /** The number of users that match the search. */
  total: number
}

/** The role names in the role claim: PLATFORM_ADMIN_ROLE and STUDIO_USER_ROLE. */
export interface StudioRoleNames {
  adminRole: string
  userRole: string
}

/** The read of the Keycloak directory that the listing makes. */
export type StudioUsersDirectory = Pick<KeycloakDirectory, 'listRoleMembers'>

export interface StudioUsersDeps {
  directory: StudioUsersDirectory
  roles: StudioRoleNames
}

/** What the Studio users page shows instead of, or as, the list. */
export type StudioUsersListing =
  | { status: 'listed'; page: StudioUsersPage }
  /** The session lives on its grace: the listing reads nothing, and the dashboard layout shows the degraded banner. */
  | { status: 'session-degraded' }
  /** Keycloak did not answer this listing before the session recheck noticed: the page shows the degraded banner. */
  | { status: 'directory-unreachable' }

function displayName(user: DirectoryUser): string | null {
  const name = [user.firstName, user.lastName].filter(part => part !== null && part !== '').join(' ')
  return name === '' ? null : name
}

/** The members of both roles, merged by Keycloak id with a badge per role they hold, in username order. */
function mergeRoleMembers(admins: DirectoryUser[], members: DirectoryUser[]): StudioUser[] {
  const merged = new Map<string, StudioUser>()
  function add(users: DirectoryUser[], role: StudioUserRole): void {
    for (const user of users) {
      const existing = merged.get(user.id)
      if (existing === undefined) {
        merged.set(user.id, {
          id: user.id,
          username: user.username,
          email: user.email,
          name: displayName(user),
          enabled: user.enabled,
          roles: [role],
        })
        continue
      }
      // The two roles are two reads, so a user disabled between them shows as disabled.
      existing.enabled = existing.enabled && user.enabled
      if (!existing.roles.includes(role)) existing.roles.push(role)
    }
  }
  add(admins, 'admin')
  add(members, 'user')
  return [...merged.values()].sort((a, b) => a.username.localeCompare(b.username))
}

function matches(user: StudioUser, needle: string): boolean {
  return [user.username, user.email, user.name].some(value => value !== null && value.toLowerCase().includes(needle))
}

function pageOf(users: StudioUser[], requested: number): StudioUsersPage {
  const pageCount = Math.max(1, Math.ceil(users.length / STUDIO_USERS_PAGE_SIZE))
  const page = Math.min(Math.max(1, requested), pageCount)
  const start = (page - 1) * STUDIO_USERS_PAGE_SIZE
  return { users: users.slice(start, start + STUDIO_USERS_PAGE_SIZE), page, pageCount, total: users.length }
}

/**
 * One page of the members of the admin and user roles, read from the Keycloak directory: directly and through groups
 * and their subgroups, disabled users included.
 * A role held only through a composite role is not listed, an unsupported assignment (docs/deploy/platform-runtime.md).
 */
export async function listStudioUsers(
  directory: StudioUsersDirectory,
  roles: StudioRoleNames,
  query: StudioUsersQuery,
): Promise<StudioUsersPage> {
  const [admins, members] = await Promise.all([
    directory.listRoleMembers(roles.adminRole),
    directory.listRoleMembers(roles.userRole),
  ])
  const needle = query.search.trim().toLowerCase()
  const users = mergeRoleMembers(admins, members)
  return pageOf(needle === '' ? users : users.filter(user => matches(user, needle)), query.page)
}

function processDeps(): StudioUsersDeps {
  const config = getRuntimeConfig()
  return {
    directory: getKeycloakDirectory(),
    roles: { adminRole: config.PLATFORM_ADMIN_ROLE, userRole: config.STUDIO_USER_ROLE },
  }
}

/**
 * The listing of the Studio users page. The list needs the Keycloak directory, so the page shows the degraded banner
 * instead while Keycloak is unreachable: a degraded session reads nothing, as requireDirectory refuses the
 * directory reads of actions, and a Keycloak that does not answer this listing is reported, not thrown.
 * Every other failure, such as a service account that Keycloak refuses, is thrown.
 */
export async function loadStudioUsers(
  user: Pick<CurrentUser, 'id' | 'directoryDegraded'>,
  query: StudioUsersQuery,
  deps?: StudioUsersDeps,
): Promise<StudioUsersListing> {
  if (user.directoryDegraded) return { status: 'session-degraded' }
  const { directory, roles } = deps ?? processDeps()
  try {
    return { status: 'listed', page: await listStudioUsers(directory, roles, query) }
  } catch (error) {
    if (!(error instanceof KeycloakUnavailableError)) throw error
    logger.warn('Studio users: the Keycloak directory is unreachable', { userId: user.id, error: error.message })
    return { status: 'directory-unreachable' }
  }
}

type SearchParams = Readonly<Record<string, string | string[] | undefined>>

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/** The query of the page URL: `q`, the search, and `page`, a page number from 1 that counts as 1 when it is not one. */
export function parseStudioUsersQuery(params: SearchParams): StudioUsersQuery {
  const page = firstValue(params.page)
  return {
    search: firstValue(params.q).trim(),
    page: /^[1-9][0-9]*$/.test(page) ? Number(page) : 1,
  }
}
