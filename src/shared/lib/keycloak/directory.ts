import { getKeycloakAdminClient, type KeycloakAdminClient } from './admin-client'
import { KeycloakConfigError, KeycloakNotFoundError, KeycloakUnavailableError } from './errors'

// The LibreDB roles are client roles of this role-holder client, which the client scope libredb-roles maps into
// the libredb_roles claim. Only this module knows it: callers name a role and never where it
// lives, so another role model changes this module and the realm, not its callers.
const ROLE_CLIENT_ID = 'libredb'

// Listings answer users and groups without their attributes and role mappings.
const BRIEF = { briefRepresentation: true } as const

/** A Keycloak user as the directory reports it. */
export interface DirectoryUser {
  /** The Keycloak user id, which is the OIDC `sub` and the subject of grants and session revocations. */
  id: string
  username: string
  email: string | null
  firstName: string | null
  lastName: string | null
  /** False for a user whom Keycloak does not let sign in. */
  enabled: boolean
}

export interface DirectoryUserSearch {
  /** Keycloak's user search: a prefix of the username, first name, last name or email, where `*` matches any text. */
  search?: string
  /** The position of the first user of the page, from 0. */
  first: number
  /** The number of users on the page, from 1. */
  max: number
}

/** The users and roles of the Keycloak realm, read through the Admin API by Platform's service account. */
export interface KeycloakDirectory {
  /**
   * Every user who holds the role directly, through a group that holds it or through a subgroup of such a group,
   * each once and in no particular order, disabled users included.
   * A user who holds the role only through a composite role is not listed; docs/deploy/platform-runtime.md documents
   * that assignment as unsupported.
   * Throws KeycloakNotFoundError when the role does not exist.
   */
  listRoleMembers(role: string): Promise<DirectoryUser[]>
  /** The user, or null when Keycloak has no user with this id. */
  getUser(id: string): Promise<DirectoryUser | null>
  /**
   * The names of the roles the user holds by any path, composite roles included.
   * Throws KeycloakNotFoundError when Keycloak has no user with this id.
   */
  getEffectiveRoles(id: string): Promise<string[]>
  /**
   * The ids of the user's Keycloak sessions, which ID tokens carry as `sid`.
   * Throws KeycloakNotFoundError when Keycloak has no user with this id.
   */
  getUserSessionIds(id: string): Promise<string[]>
  /** One page of the users that match the search, or of every user without one. */
  searchUsers(query: DirectoryUserSearch): Promise<DirectoryUser[]>
  /** The number of users that match the search, or of every user without one. */
  countUsers(search?: string): Promise<number>
}

// Encodes a path segment. The URL parser resolves `.` and `..` before the request leaves, and an empty segment
// names the parent listing, so such an id would read another Admin API resource with the service account's rights.
function segment(value: string): string {
  if (value === '' || value === '.' || value === '..') {
    throw new TypeError('A Keycloak id or role name cannot be empty, "." or ".."')
  }
  return encodeURIComponent(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

// The directory checks every field it reads, so an answer of another shape fails here instead of in a caller.

function listOf(answer: unknown, request: string): unknown[] {
  if (!Array.isArray(answer)) throw new KeycloakUnavailableError(`${request} answered a body that is not a list`)
  return answer
}

function textField(item: unknown, field: string, request: string): string {
  const value = isRecord(item) ? item[field] : undefined
  if (typeof value !== 'string' || value === '') {
    throw new KeycloakUnavailableError(`${request} answered an item without ${field}`)
  }
  return value
}

function toDirectoryUser(item: unknown, request: string): DirectoryUser {
  if (
    !isRecord(item) ||
    typeof item.id !== 'string' ||
    typeof item.username !== 'string' ||
    typeof item.enabled !== 'boolean'
  ) {
    throw new KeycloakUnavailableError(`${request} answered a user without id, username or enabled`)
  }
  return {
    id: item.id,
    username: item.username,
    email: optionalString(item.email),
    firstName: optionalString(item.firstName),
    lastName: optionalString(item.lastName),
    enabled: item.enabled,
  }
}

/** Builds a directory over the client, which resolves the uuid of the libredb client once. */
export function createKeycloakDirectory(client: KeycloakAdminClient): KeycloakDirectory {
  let pendingRoleClientUuid: Promise<string> | undefined

  async function lookUpRoleClient(): Promise<string> {
    const request = 'Keycloak Admin API GET /clients'
    const clients = listOf(await client.get<unknown>('/clients', { clientId: ROLE_CLIENT_ID }), request)
    const roleClient = clients.find(candidate => isRecord(candidate) && candidate.clientId === ROLE_CLIENT_ID)
    if (roleClient === undefined) {
      throw new KeycloakConfigError(
        `The Keycloak realm has no client ${ROLE_CLIENT_ID}, which must hold the LibreDB roles as client roles`,
      )
    }
    return textField(roleClient, 'id', request)
  }

  // Concurrent callers share one lookup, and a failed lookup is forgotten so that the next call repeats it.
  function roleClientUuid(): Promise<string> {
    pendingRoleClientUuid ??= lookUpRoleClient().catch((error: unknown) => {
      pendingRoleClientUuid = undefined
      throw error
    })
    return pendingRoleClientUuid
  }

  async function listRoleMembers(role: string): Promise<DirectoryUser[]> {
    const roleSegment = segment(role)
    const rolePath = `/clients/${segment(await roleClientUuid())}/roles/${roleSegment}`
    const [direct, holders] = await Promise.all([
      client.getPaged<unknown>(`${rolePath}/users`, BRIEF),
      client.getPaged<unknown>(`${rolePath}/groups`, BRIEF),
    ])

    const members = new Map<string, DirectoryUser>()
    function add(users: unknown[], request: string): void {
      for (const item of users) {
        const user = toDirectoryUser(item, request)
        members.set(user.id, user)
      }
    }
    add(direct, 'Keycloak Admin API GET /clients/{id}/roles/{role}/users')

    // A subgroup inherits the roles of its parents, so the members of every group below a holder hold the role.
    // The walk reads the groups level by level, and reads a group reached twice, as a holder and below one, once.
    const visited = new Set<string>()
    let level = holders.map(group => textField(group, 'id', 'Keycloak Admin API GET /clients/{id}/roles/{role}/groups'))
    while (level.length > 0) {
      const unread: string[] = []
      for (const id of level) {
        if (!visited.has(id)) {
          visited.add(id)
          unread.push(id)
        }
      }
      const groups = await Promise.all(
        unread.map(id =>
          Promise.all([
            client.getPaged<unknown>(`/groups/${segment(id)}/members`, BRIEF),
            client.getPaged<unknown>(`/groups/${segment(id)}/children`, BRIEF),
          ]),
        ),
      )
      level = []
      for (const [users, children] of groups) {
        add(users, 'Keycloak Admin API GET /groups/{id}/members')
        level.push(...children.map(group => textField(group, 'id', 'Keycloak Admin API GET /groups/{id}/children')))
      }
    }
    return [...members.values()]
  }

  async function getUser(id: string): Promise<DirectoryUser | null> {
    const path = `/users/${segment(id)}`
    let answer: unknown
    try {
      answer = await client.get<unknown>(path)
    } catch (error) {
      // Only Keycloak's own 404 means that the user does not exist; an unreachable directory never does.
      if (error instanceof KeycloakNotFoundError) return null
      throw error
    }
    return toDirectoryUser(answer, 'Keycloak Admin API GET /users/{id}')
  }

  async function getEffectiveRoles(id: string): Promise<string[]> {
    const userSegment = segment(id)
    const request = 'Keycloak Admin API GET /users/{id}/role-mappings/clients/{id}/composite'
    // The composite mappings hold every role of the client that the user has: directly, through a group or one of
    // its parents, or inside a composite role.
    const path = `/users/${userSegment}/role-mappings/clients/${segment(await roleClientUuid())}/composite`
    const roles = listOf(await client.get<unknown>(path), request)
    return roles.map(role => textField(role, 'name', request))
  }

  async function getUserSessionIds(id: string): Promise<string[]> {
    const request = 'Keycloak Admin API GET /users/{id}/sessions'
    // Keycloak answers every session at once and ignores first and max here, so the list is read in one request.
    const sessions = listOf(await client.get<unknown>(`/users/${segment(id)}/sessions`), request)
    return sessions.map(session => textField(session, 'id', request))
  }

  async function searchUsers({ search, first, max }: DirectoryUserSearch): Promise<DirectoryUser[]> {
    if (!Number.isInteger(first) || first < 0) throw new RangeError(`first must be an integer from 0, not ${first}`)
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`max must be an integer from 1, not ${max}`)
    const request = 'Keycloak Admin API GET /users'
    const users = listOf(await client.get<unknown>('/users', { search, first, max, ...BRIEF }), request)
    return users.map(user => toDirectoryUser(user, request))
  }

  async function countUsers(search?: string): Promise<number> {
    const count = await client.get<unknown>('/users/count', { search })
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw new KeycloakUnavailableError('Keycloak Admin API GET /users/count answered a body that is not a count')
    }
    return count
  }

  return { listRoleMembers, getUser, getEffectiveRoles, getUserSessionIds, searchUsers, countUsers }
}

let processDirectory: KeycloakDirectory | undefined

/**
 * The directory of this process over `getKeycloakAdminClient()`, so the uuid of the libredb client is resolved
 * once per process.
 * Throws KeycloakConfigError when the Keycloak variables are unset, as in cloud mode.
 */
export function getKeycloakDirectory(): KeycloakDirectory {
  processDirectory ??= createKeycloakDirectory(getKeycloakAdminClient())
  return processDirectory
}
