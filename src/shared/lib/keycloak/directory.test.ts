import { afterEach, describe, it, expect, vi } from 'vitest'
import { createKeycloakAdminClient } from './admin-client'
import type { KeycloakAdminConfig } from './config'
import { createKeycloakDirectory, type KeycloakDirectory } from './directory'
import { KeycloakConfigError, KeycloakUnavailableError } from './errors'

const CONFIG: KeycloakAdminConfig = {
  realm: 'libredb',
  adminBaseUrl: 'http://keycloak.test:8080/admin/realms/libredb',
  tokenEndpoint: 'http://keycloak.test:8080/realms/libredb/protocol/openid-connect/token',
  clientId: 'libredb-platform',
  clientSecret: 'client-secret-value',
}
const ADMIN_PATH = new URL(CONFIG.adminBaseUrl).pathname

// The realm of tests/fixtures/keycloak/libredb-test-realm.json, plus ivan, who has no email, in the subgroup
// analysts/juniors/interns, which also holds user itself.
// The bodies below are those that Keycloak 26.8.1 answers to the service account of libredb-platform.
const ROLE_CLIENT_UUID = '332b7468-9076-4a0b-af66-500a15e95788'
const ALICE = '00000000-0000-4000-8000-00000000a11c'
const GRACE = '00000000-0000-4000-8000-000000009ace'
const BOB = '00000000-0000-4000-8000-000000000b0b'
const DAVE = '00000000-0000-4000-8000-00000000da7e'
const ERIN = '00000000-0000-4000-8000-00000000e121'
const FRANK = '00000000-0000-4000-8000-00000000f4a2'
const CAROL = '00000000-0000-4000-8000-00000000ca20'
const IVAN = '00000000-0000-4000-8000-0000000014a0'
const DBA = '5c875637-8f18-4529-b2cf-fd74ebad2abc'
const ANALYSTS = '1a3a390a-a9d7-400e-80d5-20a067da951c'
const JUNIORS = 'd69c8e12-a26f-4404-b046-19cf16030037'
const INTERNS = '7f3c2a51-0b1e-4c7d-9a8e-2d4b6c8e0f13'

interface Person {
  id: string
  username: string
  firstName: string
  lastName: string
  email?: string
  enabled: boolean
}

function fixtureUser(id: string, username: string, firstName: string, lastName: string, enabled = true): Person {
  return { id, username, firstName, lastName, email: `${username}@libredb.test`, enabled }
}

const alice = fixtureUser(ALICE, 'alice', 'Alice', 'Admin')
const grace = fixtureUser(GRACE, 'grace', 'Grace', 'Dba')
const bob = fixtureUser(BOB, 'bob', 'Bob', 'User')
const dave = fixtureUser(DAVE, 'dave', 'Dave', 'Analyst')
const erin = fixtureUser(ERIN, 'erin', 'Erin', 'Junior')
const frank = fixtureUser(FRANK, 'frank', 'Frank', 'Disabled', false)
const ivan: Person = { id: IVAN, username: 'ivan', firstName: 'Ivan', lastName: 'Intern', enabled: true }

// A user as the listings answer it with briefRepresentation=true; Keycloak leaves out an unset email.
function brief(person: Person): Record<string, unknown> {
  return {
    id: person.id,
    username: person.username,
    firstName: person.firstName,
    lastName: person.lastName,
    ...(person.email === undefined ? {} : { email: person.email }),
    emailVerified: person.email !== undefined,
    enabled: person.enabled,
    createdTimestamp: 1792019266505,
  }
}

// A user as GET /users/{id} answers it.
function full(person: Person): Record<string, unknown> {
  return {
    ...brief(person),
    totp: false,
    disableableCredentialTypes: [],
    requiredActions: [],
    notBefore: 0,
    access: { view: true, manage: false, impersonate: false, mapRoles: false, manageGroupMembership: false },
  }
}

// A group as GET /clients/{uuid}/roles/{role}/groups answers it.
function roleGroup(id: string, path: string): Record<string, unknown> {
  return { id, name: path.split('/').pop(), path, subGroups: [] }
}

// A group as GET /groups/{id}/children answers it.
function childGroup(id: string, path: string, parentId: string, subGroupCount: number): Record<string, unknown> {
  return {
    id,
    name: path.split('/').pop(),
    path,
    parentId,
    subGroupCount,
    subGroups: [],
    access: { view: true, viewMembers: true, manageMembers: false, manage: false, manageMembership: false },
  }
}

function clientRole(name: 'admin' | 'user'): Record<string, unknown> {
  return {
    id: name === 'admin' ? '39ff844f-ada1-4fe0-8929-64ea4ba2182f' : '650e61e1-d7d8-40e1-a809-5e20f2636290',
    name,
    description: name === 'admin' ? 'LibreDB administrator' : 'LibreDB user',
    composite: false,
    clientRole: true,
    containerId: ROLE_CLIENT_UUID,
  }
}

function userSession(id: string): Record<string, unknown> {
  return {
    id,
    username: 'alice',
    userId: ALICE,
    ipAddress: '172.22.0.1',
    start: 1792019408000,
    lastAccess: 1792019408000,
    rememberMe: false,
    clients: { '37480a5c-61d8-4fb3-8aef-cb75f7e2b988': 'libredb-platform' },
    transientUser: false,
  }
}

const CLIENTS = [
  {
    id: ROLE_CLIENT_UUID,
    clientId: 'libredb',
    name: 'LibreDB roles',
    enabled: true,
    secret: '**********',
    standardFlowEnabled: false,
    serviceAccountsEnabled: false,
    publicClient: false,
    protocol: 'openid-connect',
    attributes: { 'libredb.managed': 'true' },
    access: { view: true, configure: false, manage: false },
  },
  { id: '37480a5c-61d8-4fb3-8aef-cb75f7e2b988', clientId: 'libredb-platform', name: 'LibreDB Platform', enabled: true },
  { id: '0b6f7e2e-3d1c-4a5b-9c8d-7e6f5a4b3c2d', clientId: 'libredb-studio', name: 'LibreDB Studio', enabled: true },
]

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// GET /clients matches clientId exactly, as Keycloak does without search=true.
function clientsAnswer(url: URL): Response {
  const clientId = url.searchParams.get('clientId')
  return json(200, CLIENTS.filter(client => clientId === null || client.clientId === clientId))
}

const ROLES = `/clients/${ROLE_CLIENT_UUID}/roles`
const COMPOSITE = `/role-mappings/clients/${ROLE_CLIENT_UUID}/composite`

// An Admin API path relative to the realm, and the JSON body it answers or a function of the request URL.
type Routes = Record<string, unknown>

const REALM: Routes = {
  '/clients': clientsAnswer,
  [`${ROLES}/admin/users`]: [brief(alice)],
  [`${ROLES}/admin/groups`]: [roleGroup(DBA, '/dba')],
  [`${ROLES}/user/users`]: [brief(bob), brief(frank)],
  [`${ROLES}/user/groups`]: [roleGroup(ANALYSTS, '/analysts'), roleGroup(INTERNS, '/analysts/juniors/interns')],
  [`/groups/${DBA}/members`]: [brief(grace)],
  [`/groups/${DBA}/children`]: [],
  [`/groups/${ANALYSTS}/members`]: [brief(dave), brief(bob)],
  [`/groups/${ANALYSTS}/children`]: [childGroup(JUNIORS, '/analysts/juniors', ANALYSTS, 1)],
  [`/groups/${JUNIORS}/members`]: [brief(erin)],
  [`/groups/${JUNIORS}/children`]: [childGroup(INTERNS, '/analysts/juniors/interns', JUNIORS, 0)],
  [`/groups/${INTERNS}/members`]: [brief(ivan)],
  [`/groups/${INTERNS}/children`]: [],
  [`/users/${ERIN}`]: full(erin),
  [`/users/${ERIN}${COMPOSITE}`]: [clientRole('user')],
  [`/users/${CAROL}${COMPOSITE}`]: [],
}

// Keycloak 26.8.1 pages these listings with first and max, by default 10 subgroups and 100 of anything else,
// and answers every session and every effective role at once.
function page(path: string, items: unknown[], params: URLSearchParams): unknown[] {
  if (path.endsWith('/sessions') || path.endsWith('/composite')) return items
  const first = Number(params.get('first') ?? 0)
  const max = Number(params.get('max') ?? (path.endsWith('/children') ? 10 : 100))
  return items.slice(first, first + max)
}

/**
 * A fake Keycloak behind an injected fetch: the token endpoint issues a token, an Admin API path answers its
 * route, and a path without a route answers Keycloak's 404.
 * It records every Admin API request as its path and query.
 */
function fakeKeycloak(routes: Routes) {
  const requests: string[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url === CONFIG.tokenEndpoint) {
      return json(200, { access_token: 'access-token-value', expires_in: 300, token_type: 'Bearer' })
    }
    const url = new URL(request.url)
    const path = url.pathname.slice(ADMIN_PATH.length)
    requests.push(`${path}${url.search}`)
    const answer = routes[path]
    if (answer === undefined) return json(404, { error: 'Could not find resource' })
    if (typeof answer === 'function') return answer(url)
    return json(200, Array.isArray(answer) ? page(path, answer, url.searchParams) : answer)
  })
  return { fetch, requests }
}

function directoryFor(keycloak: ReturnType<typeof fakeKeycloak>): KeycloakDirectory {
  return createKeycloakDirectory(createKeycloakAdminClient(CONFIG, { fetch: keycloak.fetch }))
}

function byUsername<T extends { username: string }>(users: T[]): T[] {
  return [...users].sort((left, right) => left.username.localeCompare(right.username))
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('createKeycloakDirectory', () => {
  it('listRoleMembers unions direct members, group members and subgroup members', async () => {
    const keycloak = fakeKeycloak(REALM)
    const directory = directoryFor(keycloak)

    expect(byUsername(await directory.listRoleMembers('user'))).toEqual([
      { id: BOB, username: 'bob', email: 'bob@libredb.test', firstName: 'Bob', lastName: 'User', enabled: true },
      { id: DAVE, username: 'dave', email: 'dave@libredb.test', firstName: 'Dave', lastName: 'Analyst', enabled: true },
      { id: ERIN, username: 'erin', email: 'erin@libredb.test', firstName: 'Erin', lastName: 'Junior', enabled: true },
      { id: FRANK, username: 'frank', email: 'frank@libredb.test', firstName: 'Frank', lastName: 'Disabled', enabled: false },
      { id: IVAN, username: 'ivan', email: null, firstName: 'Ivan', lastName: 'Intern', enabled: true },
    ])
    expect(byUsername(await directory.listRoleMembers('admin'))).toEqual([
      { id: ALICE, username: 'alice', email: 'alice@libredb.test', firstName: 'Alice', lastName: 'Admin', enabled: true },
      { id: GRACE, username: 'grace', email: 'grace@libredb.test', firstName: 'Grace', lastName: 'Dba', enabled: true },
    ])
    // interns holds user and is a subgroup of analysts, and its members and subgroups are read once.
    expect(keycloak.requests.filter(request => request.startsWith(`/groups/${INTERNS}/`))).toHaveLength(2)
  })

  it('listRoleMembers reads every page of the role and group listings', async () => {
    // Keycloak answers 100 users and 10 subgroups to a request without max.
    const people = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index): Person => ({
        id: `${prefix}-${index}`,
        username: `${prefix}-${index}`,
        firstName: 'Many',
        lastName: `${index}`,
        email: `${prefix}-${index}@libredb.test`,
        enabled: true,
      }))
    const large = 'a0d7c4be-5f0e-4d47-9a51-0c2b8e6f1d93'
    const subgroups = Array.from({ length: 11 }, (_, index) => `sub-${index}`)
    const routes: Routes = {
      '/clients': clientsAnswer,
      [`${ROLES}/user/users`]: people('direct', 101).map(brief),
      [`${ROLES}/user/groups`]: [roleGroup(large, '/large')],
      [`/groups/${large}/members`]: people('member', 101).map(brief),
      [`/groups/${large}/children`]: subgroups.map(id => childGroup(id, `/large/${id}`, large, 0)),
    }
    subgroups.forEach((id, index) => {
      routes[`/groups/${id}/members`] = people(`nested-${index}`, 1).map(brief)
      routes[`/groups/${id}/children`] = []
    })

    const members = await directoryFor(fakeKeycloak(routes)).listRoleMembers('user')

    expect(members).toHaveLength(101 + 101 + 11)
    expect(new Set(members.map(member => member.id)).size).toBe(213)
  })

  it('getUser returns null on KeycloakNotFoundError and rethrows KeycloakUnavailableError', async () => {
    const hidden = '00000000-0000-4000-8000-0000000000e1'
    const down = '00000000-0000-4000-8000-0000000000e2'
    const directory = directoryFor(
      fakeKeycloak({
        ...REALM,
        // An edge that hides the Admin API answers 404 without Keycloak's JSON body.
        [`/users/${hidden}`]: () =>
          new Response('<html><body>Not Found</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }),
        [`/users/${down}`]: () => json(503, {}),
      }),
    )

    await expect(directory.getUser(ERIN)).resolves.toEqual({
      id: ERIN,
      username: 'erin',
      email: 'erin@libredb.test',
      firstName: 'Erin',
      lastName: 'Junior',
      enabled: true,
    })
    await expect(directory.getUser('00000000-0000-4000-8000-000000000000')).resolves.toBeNull()
    await expect(directory.getUser(hidden)).rejects.toBeInstanceOf(KeycloakUnavailableError)
    await expect(directory.getUser(down)).rejects.toBeInstanceOf(KeycloakUnavailableError)
  })

  it('getEffectiveRoles lists the effective roles that a user holds on the libredb client', async () => {
    const directory = directoryFor(fakeKeycloak(REALM))

    await expect(directory.getEffectiveRoles(ERIN)).resolves.toEqual(['user'])
    await expect(directory.getEffectiveRoles(CAROL)).resolves.toEqual([])
  })

  it('getUserSessionIds reads every session in one request, because Keycloak ignores first and max there', async () => {
    const sessions = Array.from({ length: 150 }, (_, index) => userSession(`session-${index}`))
    const keycloak = fakeKeycloak({ ...REALM, [`/users/${ALICE}/sessions`]: sessions })

    const ids = await directoryFor(keycloak).getUserSessionIds(ALICE)

    expect(ids).toHaveLength(150)
    expect(ids.slice(0, 2)).toEqual(['session-0', 'session-1'])
    expect(ids[149]).toBe('session-149')
    expect(keycloak.requests).toEqual([`/users/${ALICE}/sessions`])
  })

  it('searchUsers asks Keycloak for one page of users, and countUsers counts the same search', async () => {
    const keycloak = fakeKeycloak({ ...REALM, '/users': [brief(alice), brief(dave)], '/users/count': 2 })
    const directory = directoryFor(keycloak)

    await expect(directory.searchUsers({ search: 'a', first: 0, max: 20 })).resolves.toEqual([
      { id: ALICE, username: 'alice', email: 'alice@libredb.test', firstName: 'Alice', lastName: 'Admin', enabled: true },
      { id: DAVE, username: 'dave', email: 'dave@libredb.test', firstName: 'Dave', lastName: 'Analyst', enabled: true },
    ])
    await expect(directory.countUsers('a')).resolves.toBe(2)

    const [search, count] = keycloak.requests.map(request => new URL(request, 'http://keycloak.test'))
    expect(search.pathname).toBe('/users')
    expect([search.searchParams.get('search'), search.searchParams.get('first'), search.searchParams.get('max')])
      .toEqual(['a', '0', '20'])
    expect(count.pathname).toBe('/users/count')
    expect(count.searchParams.get('search')).toBe('a')
  })

  it('searchUsers refuses a negative or fractional first and a max below 1', async () => {
    const keycloak = fakeKeycloak(REALM)
    const directory = directoryFor(keycloak)

    for (const page of [{ first: -1, max: 20 }, { first: 0.5, max: 20 }, { first: 0, max: 0 }]) {
      await expect(directory.searchUsers({ search: 'a', ...page })).rejects.toBeInstanceOf(RangeError)
    }
    expect(keycloak.requests).toEqual([])
  })

  it('sends an id as one encoded path segment and refuses an empty id, . and .. before any request', async () => {
    // An LDAP user without import has an id like f:<component>:<username>, which may hold any character.
    const federated = 'f:ldap:ivan?#1'
    const keycloak = fakeKeycloak({ ...REALM, '/users/f%3Aldap%3Aivan%3F%231': full({ ...ivan, id: federated }) })
    const directory = directoryFor(keycloak)

    await expect(directory.getUser(federated)).resolves.toMatchObject({ id: federated, username: 'ivan' })

    // The URL parser would resolve . and .. to the user listing and to the realm, which answer the service account.
    for (const id of ['', '.', '..']) {
      await expect(directory.getUser(id)).rejects.toBeInstanceOf(TypeError)
      await expect(directory.getEffectiveRoles(id)).rejects.toBeInstanceOf(TypeError)
      await expect(directory.getUserSessionIds(id)).rejects.toBeInstanceOf(TypeError)
      await expect(directory.listRoleMembers(id)).rejects.toBeInstanceOf(TypeError)
    }
    expect(keycloak.requests).toEqual(['/users/f%3Aldap%3Aivan%3F%231'])
  })

  it('an answer without the fields the directory reports throws KeycloakUnavailableError', async () => {
    const directory = directoryFor(
      fakeKeycloak({
        ...REALM,
        [`/users/${ERIN}`]: { id: ERIN, username: 'erin' },
        [`/users/${ERIN}/sessions`]: { id: 'session-0' },
        [`/users/${ERIN}${COMPOSITE}`]: [{ id: '650e61e1-d7d8-40e1-a809-5e20f2636290' }],
        [`${ROLES}/user/users`]: [{ username: 'bob', enabled: true }],
        '/users': [{ id: ALICE, enabled: true }],
        '/users/count': '2',
      }),
    )

    for (const call of [
      () => directory.getUser(ERIN),
      () => directory.getUserSessionIds(ERIN),
      () => directory.getEffectiveRoles(ERIN),
      () => directory.listRoleMembers('user'),
      () => directory.searchUsers({ first: 0, max: 20 }),
      () => directory.countUsers(),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(KeycloakUnavailableError)
    }
  })

  it('a realm without the libredb client throws KeycloakConfigError', async () => {
    const directory = directoryFor(fakeKeycloak({ ...REALM, '/clients': () => json(200, CLIENTS.slice(1)) }))

    const error = await rejection(directory.listRoleMembers('user'))

    expect(error).toBeInstanceOf(KeycloakConfigError)
    expect(error.message).toMatch(/no client libredb\b/)
  })

  it('a failed lookup of the libredb client is retried by the next call', async () => {
    let lookups = 0
    const directory = directoryFor(
      fakeKeycloak({ ...REALM, '/clients': (url: URL) => (++lookups === 1 ? json(503, {}) : clientsAnswer(url)) }),
    )

    await expect(directory.getEffectiveRoles(ERIN)).rejects.toBeInstanceOf(KeycloakUnavailableError)
    await expect(directory.getEffectiveRoles(ERIN)).resolves.toEqual(['user'])
    expect(lookups).toBe(2)
  })
})

describe('getKeycloakDirectory', () => {
  const VARIABLES = [
    'NODE_ENV',
    'DEPLOYMENT_MODE',
    'DATABASE_URL',
    'AUTH_SECRET',
    'AUTH_SECRET_PREVIOUS',
    'AUTH_URL',
    'STUDIO_PUBLIC_URL',
    'AUTH_KEYCLOAK_ISSUER',
    'AUTH_KEYCLOAK_ID',
    'AUTH_KEYCLOAK_SECRET',
    'KEYCLOAK_ADMIN_URL',
    'BRIDGE_SEAL_PUBLIC_KEY',
    'PLATFORM_LICENSE',
  ]
  const SELF_HOSTED: Record<string, string> = {
    NODE_ENV: 'test',
    DEPLOYMENT_MODE: 'self-hosted',
    DATABASE_URL: 'postgresql://libredb_platform:db-password-value@db.internal:5432/libredb?schema=platform',
    AUTH_SECRET: 'auth-secret-value-of-at-least-32-characters',
    STUDIO_PUBLIC_URL: 'https://studio.libredb.test',
    AUTH_KEYCLOAK_ISSUER: 'http://keycloak.test:8080/realms/libredb',
    AUTH_KEYCLOAK_ID: 'libredb-platform',
    AUTH_KEYCLOAK_SECRET: 'client-secret-value',
    // The recipient key of Studio's lsb1 test vectors, a published test key.
    BRIDGE_SEAL_PUBLIC_KEY: 'b6-f045B6re3Ue7V8Cr5jO9ApZzyOxGk659gM3tn5wE',
    // Self-hosted mode requires a license token, which nothing here verifies; no key signed this one.
    PLATFORM_LICENSE: 'ldl1.0123456789abcdef.e30.AA',
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('resolves the libredb client uuid once per process', async () => {
    for (const name of VARIABLES) vi.stubEnv(name, SELF_HOSTED[name])
    const keycloak = fakeKeycloak(REALM)
    vi.stubGlobal('fetch', keycloak.fetch)
    vi.resetModules()
    const { getKeycloakDirectory } = await import('./directory')

    expect(getKeycloakDirectory()).toBe(getKeycloakDirectory())
    await Promise.all([
      getKeycloakDirectory().listRoleMembers('admin'),
      getKeycloakDirectory().listRoleMembers('user'),
      getKeycloakDirectory().getEffectiveRoles(ERIN),
    ])
    await expect(getKeycloakDirectory().getEffectiveRoles(CAROL)).resolves.toEqual([])

    expect(keycloak.requests.filter(request => request.startsWith('/clients?'))).toEqual(['/clients?clientId=libredb'])
  })
})
