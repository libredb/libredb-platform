import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Row = Record<string, unknown>

// The session that auth() returns: a Keycloak admin of the install tenant.
const session = vi.hoisted(() => ({
  user: { id: 'user-alice', email: 'alice@libredb.test', name: 'Alice' },
  authProvider: 'keycloak',
  currentTenantId: 'tenant-install',
  membershipId: null,
  roles: ['PLATFORM_ADMIN'] as string[],
  permissions: [] as string[],
  accessibleTenants: [],
  directoryDegraded: false,
}))

vi.mock('@/shared/lib/auth', () => ({ auth: vi.fn(async () => session) }))

// An in-memory stand-in for the two tables the action writes. $transaction hands its callback a client of its own,
// whose writes reach the tables only when the callback returns, as a committed transaction would.
const { db, tables, tx, ids } = vi.hoisted(() => {
  const tables: { sessionRevocation: Row[]; adminAction: Row[] } = { sessionRevocation: [], adminAction: [] }
  let pending: { sessionRevocation: Row[]; adminAction: Row[] } | null = null
  const ids = { next: 1 }

  function inTransaction() {
    if (pending === null) throw new Error('written outside a transaction')
    return pending
  }

  const tx = {
    sessionRevocation: {
      create: vi.fn(async ({ data, select }: { data: Row; select?: Record<string, boolean> }) => {
        // The database generates id and revokedBefore.
        const row: Row = { id: `revocation-${ids.next++}`, revokedBefore: new Date('2026-10-15T09:30:00.000Z'), ...data }
        inTransaction().sessionRevocation.push(row)
        return select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row
      }),
    },
    adminAction: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        inTransaction().adminAction.push(data)
        return data
      }),
    },
  }

  const db = {
    sessionRevocation: { create: vi.fn() },
    adminAction: { create: vi.fn() },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>): Promise<unknown> => {
      pending = { sessionRevocation: [], adminAction: [] }
      try {
        const result = await run(tx)
        tables.sessionRevocation.push(...pending.sessionRevocation)
        tables.adminAction.push(...pending.adminAction)
        return result
      } finally {
        pending = null
      }
    }),
  }
  return { db, tables, tx, ids }
})

vi.mock('@/shared/lib/db', () => ({ db }))

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { revokeStudioSessions } from './revoke-studio-sessions'

// Bob's Keycloak user id in the fixture realm.
const BOB = '00000000-0000-4000-8000-000000000b0b'

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  session.roles = ['PLATFORM_ADMIN']
  session.permissions = []
  session.directoryDegraded = false
  tables.sessionRevocation = []
  tables.adminAction = []
  ids.next = 1
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('revokeStudioSessions', () => {
  it('inserts one admin revocation and one admin action in one transaction and returns only the id', async () => {
    const result = await revokeStudioSessions({ subject: BOB })

    expect(result).toEqual({ success: true, data: { id: 'revocation-1' } })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.sessionRevocation.create).not.toHaveBeenCalled()
    expect(db.adminAction.create).not.toHaveBeenCalled()
    expect(tx.sessionRevocation.create).toHaveBeenCalledTimes(1)
    expect(tx.adminAction.create).toHaveBeenCalledTimes(1)

    expect(tables.sessionRevocation).toEqual([
      {
        id: 'revocation-1',
        revokedBefore: new Date('2026-10-15T09:30:00.000Z'),
        subject: BOB,
        reason: 'admin',
        createdById: 'user-alice',
      },
    ])
    expect(tables.adminAction).toEqual([
      {
        actorId: 'user-alice',
        channel: 'web',
        action: 'revocation.create',
        targetType: 'session_revocation',
        targetId: 'revocation-1',
        before: Prisma.DbNull,
        after: { subject: BOB, reason: 'admin', revokedBefore: '2026-10-15T09:30:00.000Z' },
      },
    ])
  })

  it('a caller without PLATFORM_ADMIN is forbidden', async () => {
    session.roles = ['TENANT_ADMIN']
    session.permissions = ['user.edit', 'user.delete', 'settings.edit']

    const result = await revokeStudioSessions({ subject: BOB })

    expect(result).toEqual({ success: false, error: 'Permission denied' })
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(tables.sessionRevocation).toEqual([])
    expect(tables.adminAction).toEqual([])
  })

  it('works while the directory is degraded, because a revocation needs no directory read', async () => {
    session.directoryDegraded = true

    const result = await revokeStudioSessions({ subject: BOB })

    expect(result).toEqual({ success: true, data: { id: 'revocation-1' } })
    expect(tables.sessionRevocation).toHaveLength(1)
  })

  it('refuses a subject outside 1 to 512 characters', async () => {
    for (const subject of ['', 'x'.repeat(513)]) {
      const result = await revokeStudioSessions({ subject })

      expect(result).toMatchObject({ success: false, error: 'Validation failed', fieldErrors: { subject: [expect.any(String)] } })
    }
    expect(db.$transaction).not.toHaveBeenCalled()

    // An LDAP-federated user without import has an id such as f:<component>:<username>, up to 512 characters.
    const federated = 'f:ldap:'.padEnd(512, 'u')
    expect(await revokeStudioSessions({ subject: federated })).toEqual({ success: true, data: { id: 'revocation-1' } })
    expect(tables.sessionRevocation[0].subject).toBe(federated)
  })

  it('is refused in cloud mode, where no Studio reads the revocations', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')

    const result = await revokeStudioSessions({ subject: BOB })

    expect(result).toEqual({ success: false, error: 'Permission denied: not available in cloud mode' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})
