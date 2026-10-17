import { describe, expect, it, vi } from 'vitest'
import { KeycloakNotFoundError, KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'
import type { DirectoryUser } from '@/shared/lib/keycloak/directory'
import { toConnectionAccess, type ConnectionAccessDeps } from './connection-access'
import type { GrantWithGranter } from './grant.repository'

vi.mock('@/shared/lib/db', () => ({ db: {} }))

const ROLES = { adminRole: 'admin', userRole: 'user' }
const ADMIN = { id: 'platform-user-1', directoryDegraded: false }

function grant(subject: string, username: string, overrides: Partial<GrantWithGranter> = {}): GrantWithGranter {
  return {
    id: `grant-${username}`,
    connectionId: 'connection-1',
    subjectKind: 'user',
    subject,
    subjectUsername: username,
    subjectEmail: `${username}@libredb.test`,
    level: 'read',
    expiresAt: null,
    grantedById: ADMIN.id,
    grantedBy: { name: 'Alice Admin', email: 'alice@libredb.test' },
    grantedAt: new Date('2026-10-15T08:30:00.000Z'),
    updatedAt: new Date('2026-10-15T08:30:00.000Z'),
    ...overrides,
  }
}

function directoryUser(id: string, username: string, enabled = true): DirectoryUser {
  return { id, username, email: null, firstName: null, lastName: null, enabled }
}

function depsOf(users: Record<string, { user: DirectoryUser; roles: string[] }>): ConnectionAccessDeps {
  return {
    roles: ROLES,
    directory: {
      getUser: vi.fn(async (id: string) => users[id]?.user ?? null),
      getEffectiveRoles: vi.fn(async (id: string) => {
        const entry = users[id]
        if (!entry) throw new KeycloakNotFoundError(`user ${id}`)
        return entry.roles
      }),
    },
  }
}

describe('toConnectionAccess', () => {
  it('gives each subject its live role badge and flags one Keycloak no longer knows', async () => {
    const deps = depsOf({
      'kc-alice': { user: directoryUser('kc-alice', 'alice'), roles: ['admin', 'user', 'offline_access'] },
      'kc-bob': { user: directoryUser('kc-bob', 'bob', false), roles: ['user'] },
    })
    const access = await toConnectionAccess(
      [grant('kc-alice', 'alice'), grant('kc-bob', 'bob'), grant('kc-gone', 'zoe')],
      true,
      ADMIN,
      deps,
    )

    expect(access.directory).toBe('available')
    expect(access.grants.map((g) => [g.username, g.directory])).toEqual([
      ['alice', { status: 'present', studioRole: 'admin', enabled: true }],
      ['bob', { status: 'present', studioRole: 'user', enabled: false }],
      ['zoe', { status: 'missing' }],
    ])
    expect(access.grants[0]).toMatchObject({
      id: 'grant-alice',
      subject: 'kc-alice',
      email: 'alice@libredb.test',
      level: 'read',
      downgraded: false,
      expiresAt: null,
      grantedBy: 'Alice Admin',
      grantedAt: '2026-10-15T08:30:00.000Z',
    })
  })

  it('marks a write grant downgraded when the connection has no write credential, and names the granter by email without a name', async () => {
    const deps = depsOf({ 'kc-bob': { user: directoryUser('kc-bob', 'bob'), roles: [] } })
    const access = await toConnectionAccess(
      [
        grant('kc-bob', 'bob', {
          level: 'write',
          expiresAt: new Date('2026-12-31T00:00:00.000Z'),
          grantedBy: { name: null, email: 'alice@libredb.test' },
        }),
      ],
      false,
      ADMIN,
      deps,
    )
    expect(access.grants[0]).toMatchObject({
      level: 'write',
      downgraded: true,
      expiresAt: '2026-12-31T00:00:00.000Z',
      grantedBy: 'alice@libredb.test',
      directory: { status: 'present', studioRole: null, enabled: true },
    })
  })

  it('reads nothing from Keycloak while the session is degraded', async () => {
    const deps = depsOf({})
    const access = await toConnectionAccess([grant('kc-bob', 'bob')], true, { ...ADMIN, directoryDegraded: true }, deps)
    expect(access.directory).toBe('degraded')
    expect(access.grants[0].directory).toEqual({ status: 'unknown' })
    expect(deps.directory.getUser).not.toHaveBeenCalled()
  })

  it('reports a Keycloak that does not answer and leaves every subject unknown', async () => {
    const deps = depsOf({})
    vi.mocked(deps.directory.getUser).mockRejectedValue(new KeycloakUnavailableError('connection refused'))
    const access = await toConnectionAccess([grant('kc-bob', 'bob')], true, ADMIN, deps)
    expect(access.directory).toBe('unreachable')
    expect(access.grants[0].directory).toEqual({ status: 'unknown' })
  })

  it('throws any other failure of the directory', async () => {
    const deps = depsOf({})
    vi.mocked(deps.directory.getUser).mockRejectedValue(new Error('service account refused'))
    await expect(toConnectionAccess([grant('kc-bob', 'bob')], true, ADMIN, deps)).rejects.toThrow('service account refused')
  })
})
