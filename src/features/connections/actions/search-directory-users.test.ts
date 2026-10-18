import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DirectoryUser, DirectoryUserSearch } from '@/shared/lib/keycloak/directory'

const caller = vi.hoisted(() => ({
  id: 'user-alice',
  email: 'alice@libredb.test',
  name: 'Alice',
  authProvider: 'keycloak',
  currentTenantId: 'tenant-1',
  membershipId: null,
  roles: ['TENANT_ADMIN'],
  permissions: ['connection.view', 'connection.create', 'connection.edit', 'connection.delete'] as string[],
  accessibleTenants: [],
  directoryDegraded: false,
}))

const requirePermission = vi.hoisted(() =>
  vi.fn(async (user: { permissions: string[] }, permission: string) => {
    if (!user.permissions.includes(permission)) {
      const { ForbiddenError } = await import('@/shared/lib/errors')
      throw new ForbiddenError(permission)
    }
  }),
)

vi.mock('@/shared/lib/auth-utils', () => ({
  getCurrentUser: vi.fn(async () => caller),
  requirePermission,
}))

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// The validated runtime configuration, whose PLATFORM_ADMIN_ROLE and STUDIO_USER_ROLE name the LibreDB roles.
const runtime = vi.hoisted(() => ({ config: {} as Record<string, unknown> }))
vi.mock('@/shared/lib/runtime-config', () => ({ getRuntimeConfig: () => runtime.config }))

// A Keycloak directory over a list of users, searched as Keycloak 26.8.1 searches them: a search matches the start of
// the username, first name, last name or email without regard to case, and `*` in it matches any text.
const directory = vi.hoisted(() => {
  const state = { users: [] as DirectoryUser[], roles: new Map<string, string[]>() }
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  function matching(search: string | undefined): DirectoryUser[] {
    if (search === undefined) return state.users
    const pattern = new RegExp(`^${search.split('*').map(escape).join('.*')}`, 'i')
    return state.users.filter((user) =>
      [user.username, user.firstName, user.lastName, user.email].some((value) => value !== null && pattern.test(value)))
  }
  return {
    state,
    searchUsers: vi.fn(async ({ search, first, max }: DirectoryUserSearch) =>
      matching(search).slice(first, first + max)),
    countUsers: vi.fn(async (search?: string) => matching(search).length),
    getEffectiveRoles: vi.fn(async (id: string) => state.roles.get(id) ?? []),
  }
})
vi.mock('@/shared/lib/keycloak/directory', () => ({ getKeycloakDirectory: () => directory }))

// The license status of the install, null where licensing does not apply, and the Keycloak users who hold a user seat.
const license = vi.hoisted(() => ({ status: null as unknown, seatHolders: new Set<string>() }))
vi.mock('@/shared/lib/license/install-license', () => ({ getLicenseStatus: () => license.status }))
const userSeatHolders = vi.hoisted(() =>
  vi.fn(async (subjects: readonly string[]) => new Set(subjects.filter((subject) => license.seatHolders.has(subject)))),
)
vi.mock('../lib/grant.repository', () => ({ ConnectionGrantRepository: { userSeatHolders } }))

import { SMALL_LICENSE_ACTIVE } from '../../../../tests/license/statuses'
import { searchDirectoryUsers } from './search-directory-users'

// Keycloak user ids of the fixture realm, tests/fixtures/keycloak/libredb-test-realm.json.
const ALICE = '00000000-0000-4000-8000-00000000a11c'
const GRACE = '00000000-0000-4000-8000-000000009ace'
const BOB = '00000000-0000-4000-8000-000000000b0b'
const FRANK = '00000000-0000-4000-8000-00000000f4a2'
const CAROL = '00000000-0000-4000-8000-00000000ca20'
const HENRY = '00000000-0000-4000-8000-0000000000e1'

type SearchInput = Parameters<typeof searchDirectoryUsers>[0]

async function search(input: SearchInput) {
  const result = await searchDirectoryUsers(input)
  if (!result.success) throw new Error(`searchDirectoryUsers failed: ${result.error}`)
  return result.data
}

function user(
  id: string,
  username: string,
  firstName: string | null,
  lastName: string | null,
  enabled = true,
): DirectoryUser {
  return { id, username, email: `${username}@libredb.test`, firstName, lastName, enabled }
}

beforeEach(() => {
  caller.permissions = ['connection.view', 'connection.create', 'connection.edit', 'connection.delete']
  caller.directoryDegraded = false
  runtime.config = { PLATFORM_ADMIN_ROLE: 'admin', STUDIO_USER_ROLE: 'user' }
  license.status = null
  license.seatHolders = new Set()
  // 45 users: the realm's admins alice and grace, bob and the disabled frank with the user role, carol with no role,
  // henry with both roles, and 39 analysts, every second one with the user role.
  const analysts = Array.from({ length: 39 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0')
    return user(`00000000-0000-4000-8000-0000000100${number}`, `analyst${number}`, 'Analyst', number)
  })
  directory.state.users = [
    user(ALICE, 'alice', 'Alice', 'Admin'),
    user(GRACE, 'grace', 'Grace', 'Dba'),
    user(BOB, 'bob', 'Bob', 'User'),
    user(FRANK, 'frank', 'Frank', 'Disabled', false),
    user(CAROL, 'carol', 'Carol', 'Norole'),
    user(HENRY, 'henry', null, null),
    ...analysts,
  ]
  directory.state.roles = new Map([
    // Effective roles include those held through a group and composite roles, such as offline_access here.
    [ALICE, ['admin']],
    [GRACE, ['admin', 'offline_access']],
    [BOB, ['user']],
    [FRANK, ['user']],
    [CAROL, ['offline_access']],
    [HENRY, ['user', 'admin']],
    ...analysts.map((analyst, index): [string, string[]] => [analyst.id, index % 2 === 0 ? ['user'] : []]),
  ])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('searchDirectoryUsers', () => {
  it('returns 20 users per page with an admin, user or empty badge', async () => {
    const first = await search({ search: '', page: 1 })

    expect(first.page).toBe(1)
    expect(first.total).toBe(45)
    expect(first.users).toHaveLength(20)
    expect(directory.searchUsers).toHaveBeenLastCalledWith({ search: undefined, first: 0, max: 20 })
    expect(directory.countUsers).toHaveBeenLastCalledWith(undefined)
    // admin wins over user, and roles other than the two LibreDB roles give no badge.
    expect(first.users.slice(0, 8).map(({ username, studioRole }) => [username, studioRole])).toEqual([
      ['alice', 'admin'],
      ['grace', 'admin'],
      ['bob', 'user'],
      ['frank', 'user'],
      ['carol', null],
      ['henry', 'admin'],
      ['analyst01', 'user'],
      ['analyst02', null],
    ])
    // The picker shows a disabled user as such, because a grant to one is refused.
    expect(first.users[3]).toEqual({
      id: FRANK,
      username: 'frank',
      email: 'frank@libredb.test',
      firstName: 'Frank',
      lastName: 'Disabled',
      enabled: false,
      studioRole: 'user',
      needsSeat: false,
    })

    const last = await search({ search: '', page: 3 })

    expect(last.page).toBe(3)
    expect(last.total).toBe(45)
    expect(last.users.map((found) => found.username)).toEqual([
      'analyst35',
      'analyst36',
      'analyst37',
      'analyst38',
      'analyst39',
    ])
    expect(directory.searchUsers).toHaveBeenLastCalledWith({ search: undefined, first: 40, max: 20 })
    // One role read per user shown.
    expect(directory.getEffectiveRoles).toHaveBeenCalledTimes(25)
  })

  it('matches the typed text anywhere in the username, name or email', async () => {
    // Keycloak matches the start of a field, so the trimmed text is wrapped in * and found inside alice's last name.
    const matched = await search({ search: ' dmi ', page: 1 })

    expect(directory.searchUsers).toHaveBeenLastCalledWith({ search: '*dmi*', first: 0, max: 20 })
    expect(directory.countUsers).toHaveBeenLastCalledWith('*dmi*')
    expect(matched).toEqual({
      users: [expect.objectContaining({ id: ALICE, username: 'alice', studioRole: 'admin' })],
      page: 1,
      total: 1,
    })

    // Without regard to case, as Keycloak searches.
    const bob = await search({ search: 'OB', page: 1 })
    expect(bob.users.map((found) => found.username)).toEqual(['bob'])
  })

  it('reads the role names from PLATFORM_ADMIN_ROLE and STUDIO_USER_ROLE', async () => {
    runtime.config = { PLATFORM_ADMIN_ROLE: 'libredb-admin', STUDIO_USER_ROLE: 'libredb-user' }
    directory.state.roles = new Map([
      [ALICE, ['admin', 'libredb-user']],
      [GRACE, ['libredb-admin']],
    ])

    const found = await search({ search: '', page: 1 })

    expect(found.users.slice(0, 3).map(({ username, studioRole }) => [username, studioRole])).toEqual([
      ['alice', 'user'],
      ['grace', 'admin'],
      ['bob', null],
    ])
  })

  it('marks each user who holds no user seat, whom a grant would give a new one', async () => {
    license.status = SMALL_LICENSE_ACTIVE
    // alice holds a seat through a grant as an admin, and bob as a user.
    license.seatHolders = new Set([ALICE, BOB])

    const found = await search({ search: '', page: 1 })

    expect(found.users.slice(0, 6).map(({ username, needsSeat }) => [username, needsSeat])).toEqual([
      ['alice', false],
      ['grace', true],
      ['bob', false],
      ['frank', true],
      ['carol', true],
      ['henry', true],
    ])
    // One read of the seats for the users of the page.
    expect(userSeatHolders).toHaveBeenCalledTimes(1)
    expect(userSeatHolders).toHaveBeenCalledWith(found.users.map((match) => match.id))
  })

  it('marks nobody and reads no seat where licensing does not apply', async () => {
    license.seatHolders = new Set([ALICE])

    const found = await search({ search: '', page: 1 })

    expect(found.users.every((match) => !match.needsSeat)).toBe(true)
    expect(userSeatHolders).not.toHaveBeenCalled()
  })

  it('requires connection.edit and a directory that is not degraded', async () => {
    caller.permissions = ['connection.view']
    expect(await searchDirectoryUsers({ search: '', page: 1 })).toEqual({
      success: false,
      error: 'Permission denied: connection.edit',
    })

    caller.permissions = ['connection.view', 'connection.edit']
    caller.directoryDegraded = true
    expect(await searchDirectoryUsers({ search: '', page: 1 })).toEqual({
      success: false,
      error: 'Permission denied: the Keycloak directory is unreachable',
    })
    expect(directory.searchUsers).not.toHaveBeenCalled()

    caller.directoryDegraded = false
    for (const page of [0, 1.5]) {
      expect(await searchDirectoryUsers({ search: '', page })).toEqual({
        success: false,
        error: 'Validation failed',
        fieldErrors: { page: [expect.any(String)] },
      })
    }
    expect(directory.searchUsers).not.toHaveBeenCalled()
  })
})
