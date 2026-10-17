import { afterEach, describe, it, expect, vi } from 'vitest'
import type { DirectoryUser } from '@/shared/lib/keycloak/directory'
import { KeycloakPermissionError, KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'
import type { CurrentUser } from '@/shared/types'

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  STUDIO_USERS_PAGE_SIZE,
  listStudioUsers,
  loadStudioUsers,
  parseStudioUsersQuery,
  type StudioUsersDirectory,
} from './studio-users'

const ROLES = { adminRole: 'admin', userRole: 'user' }

function member(username: string, overrides: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    id: `kc-${username}`,
    username,
    email: `${username}@libredb.test`,
    firstName: null,
    lastName: null,
    enabled: true,
    ...overrides,
  }
}

// user01 to user25 hold the user role.
const USERS = Array.from({ length: 25 }, (_, index) => member(`user${String(index + 1).padStart(2, '0')}`))

/** A directory whose roles have the given members; the admin and user roles are named as in ROLES. */
function directoryOf(members: Record<string, DirectoryUser[]>): StudioUsersDirectory & { listRoleMembers: ReturnType<typeof vi.fn> } {
  return {
    listRoleMembers: vi.fn(async (role: string) => {
      const users = members[role]
      if (!users) throw new Error(`unexpected role ${role}`)
      // A copy, as each Admin API read answers fresh objects.
      return users.map((user) => ({ ...user }))
    }),
  }
}

function admin(directoryDegraded = false): CurrentUser {
  return {
    id: 'user-alice',
    email: 'alice@libredb.test',
    name: 'Alice',
    authProvider: 'keycloak',
    currentTenantId: 'tenant-install',
    membershipId: null,
    roles: ['PLATFORM_ADMIN'],
    permissions: [],
    accessibleTenants: [],
    directoryDegraded,
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('listStudioUsers', () => {
  it('merges admin and user members by id, keeps both badges and pages 20 at a time', async () => {
    // alice holds only admin; user03 and user07 hold both roles, so the 28 memberships are 26 users.
    const directory = directoryOf({
      admin: [member('alice'), USERS[2], USERS[6]],
      user: USERS,
    })

    const first = await listStudioUsers(directory, ROLES, { search: '', page: 1 })

    expect(directory.listRoleMembers).toHaveBeenCalledTimes(2)
    expect(directory.listRoleMembers).toHaveBeenCalledWith('admin')
    expect(directory.listRoleMembers).toHaveBeenCalledWith('user')
    expect(STUDIO_USERS_PAGE_SIZE).toBe(20)
    expect(first.total).toBe(26)
    expect(first.page).toBe(1)
    expect(first.pageCount).toBe(2)
    expect(first.users.map((user) => user.username)).toEqual([
      'alice',
      ...USERS.slice(0, 19).map((user) => user.username),
    ])
    expect(first.users[0]).toEqual({
      id: 'kc-alice',
      username: 'alice',
      email: 'alice@libredb.test',
      name: null,
      enabled: true,
      roles: ['admin'],
    })
    const byName = new Map(first.users.map((user) => [user.username, user]))
    expect(byName.get('user03')?.roles).toEqual(['admin', 'user'])
    expect(byName.get('user07')?.roles).toEqual(['admin', 'user'])
    expect(byName.get('user01')?.roles).toEqual(['user'])

    const second = await listStudioUsers(directory, ROLES, { search: '', page: 2 })

    expect(second.page).toBe(2)
    expect(second.pageCount).toBe(2)
    expect(second.total).toBe(26)
    expect(second.users.map((user) => user.username)).toEqual(USERS.slice(19).map((user) => user.username))
  })

  it('reads the roles that PLATFORM_ADMIN_ROLE and STUDIO_USER_ROLE name', async () => {
    const directory = directoryOf({ dba: [member('grace')], analyst: [member('dave')] })

    const page = await listStudioUsers(directory, { adminRole: 'dba', userRole: 'analyst' }, { search: '', page: 1 })

    expect(page.users.map((user) => [user.username, user.roles])).toEqual([
      ['dave', ['user']],
      ['grace', ['admin']],
    ])
  })

  it('shows a disabled member as disabled, and joins first and last name', async () => {
    const directory = directoryOf({
      admin: [member('alice', { firstName: 'Alice', lastName: 'Admin' })],
      user: [member('frank', { enabled: false, firstName: 'Frank' }), member('bob', { email: null, lastName: 'Builder' })],
    })

    const page = await listStudioUsers(directory, ROLES, { search: '', page: 1 })

    expect(page.users).toEqual([
      { id: 'kc-alice', username: 'alice', email: 'alice@libredb.test', name: 'Alice Admin', enabled: true, roles: ['admin'] },
      { id: 'kc-bob', username: 'bob', email: null, name: 'Builder', enabled: true, roles: ['user'] },
      { id: 'kc-frank', username: 'frank', email: 'frank@libredb.test', name: 'Frank', enabled: false, roles: ['user'] },
    ])
  })

  it('searches username, email and name without regard to case, before paging', async () => {
    const directory = directoryOf({
      admin: [member('alice', { firstName: 'Alice', lastName: 'Ng' })],
      user: [
        ...USERS,
        member('bob', { email: 'robert@example.com' }),
        member('carla', { firstName: 'Carla', lastName: 'Bobrova' }),
      ],
    })

    const byText = await listStudioUsers(directory, ROLES, { search: 'BOB', page: 1 })
    expect(byText.users.map((user) => user.username)).toEqual(['bob', 'carla'])
    expect(byText.total).toBe(2)
    expect(byText.pageCount).toBe(1)

    const byEmail = await listStudioUsers(directory, ROLES, { search: 'example.com', page: 1 })
    expect(byEmail.users.map((user) => user.username)).toEqual(['bob'])

    const byPrefix = await listStudioUsers(directory, ROLES, { search: 'user2', page: 1 })
    expect(byPrefix.users.map((user) => user.username)).toEqual(['user20', 'user21', 'user22', 'user23', 'user24', 'user25'])

    const none = await listStudioUsers(directory, ROLES, { search: 'nobody', page: 1 })
    expect(none).toEqual({ users: [], page: 1, pageCount: 1, total: 0 })
  })

  it('shows the last page for a page past it', async () => {
    const directory = directoryOf({ admin: [], user: USERS })

    const page = await listStudioUsers(directory, ROLES, { search: '', page: 9 })

    expect(page.page).toBe(2)
    expect(page.users.map((user) => user.username)).toEqual(USERS.slice(20).map((user) => user.username))
  })
})

describe('loadStudioUsers', () => {
  it('does not read the directory while the session is degraded', async () => {
    const directory = directoryOf({ admin: [member('alice')], user: [] })

    const listing = await loadStudioUsers(admin(true), { search: '', page: 1 }, { directory, roles: ROLES })

    expect(listing).toEqual({ status: 'session-degraded' })
    expect(directory.listRoleMembers).not.toHaveBeenCalled()
  })

  it('lists a page while the directory answers', async () => {
    const directory = directoryOf({ admin: [member('alice')], user: [member('bob')] })

    const listing = await loadStudioUsers(admin(), { search: 'bob', page: 1 }, { directory, roles: ROLES })

    expect(listing).toEqual({
      status: 'listed',
      page: {
        users: [{ id: 'kc-bob', username: 'bob', email: 'bob@libredb.test', name: null, enabled: true, roles: ['user'] }],
        page: 1,
        pageCount: 1,
        total: 1,
      },
    })
  })

  it('reports a Keycloak that does not answer as unreachable, and throws any other failure', async () => {
    const unreachable: StudioUsersDirectory = {
      listRoleMembers: vi.fn(async () => {
        throw new KeycloakUnavailableError('Keycloak Admin API GET /clients did not answer within 5 s')
      }),
    }
    expect(await loadStudioUsers(admin(), { search: '', page: 1 }, { directory: unreachable, roles: ROLES })).toEqual({
      status: 'directory-unreachable',
    })

    // A service account without its realm-management roles is a configuration error, not an outage.
    const refused: StudioUsersDirectory = {
      listRoleMembers: vi.fn(async () => {
        throw new KeycloakPermissionError('Keycloak Admin API GET /clients answered 403')
      }),
    }
    await expect(loadStudioUsers(admin(), { search: '', page: 1 }, { directory: refused, roles: ROLES })).rejects.toThrow(
      KeycloakPermissionError,
    )
  })
})

describe('parseStudioUsersQuery', () => {
  it('reads the search and the page from the search params', () => {
    expect(parseStudioUsersQuery({})).toEqual({ search: '', page: 1 })
    expect(parseStudioUsersQuery({ q: '  bob ', page: '2' })).toEqual({ search: 'bob', page: 2 })
    expect(parseStudioUsersQuery({ q: ['erin', 'frank'], page: ['3', '4'] })).toEqual({ search: 'erin', page: 3 })
    for (const page of ['0', '-1', '1.5', 'two', '', '1e3']) {
      expect(parseStudioUsersQuery({ page }), `page=${page}`).toEqual({ search: '', page: 1 })
    }
  })
})
