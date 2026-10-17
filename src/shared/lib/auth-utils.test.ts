import { describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => vi.fn())

// getCurrentUser reads the session payload that the session callback of auth-callbacks.ts builds.
vi.mock('./auth', () => ({ auth: () => auth() }))

import { getCurrentUser } from './auth-utils'

describe('getCurrentUser', () => {
  it('carries the authProvider and directoryDegraded of the session', async () => {
    auth.mockResolvedValue({
      user: { id: 'user-alice', email: 'alice@libredb.test', name: 'Alice Admin' },
      expires: '2026-10-23T08:00:00.000Z',
      authProvider: 'keycloak',
      currentTenantId: 'tenant-install',
      membershipId: null,
      roles: ['PLATFORM_ADMIN'],
      permissions: ['connection.view'],
      accessibleTenants: [{ id: 'tenant-install', name: 'Acme', slug: 'default' }],
      directoryDegraded: true,
    })

    await expect(getCurrentUser()).resolves.toEqual({
      id: 'user-alice',
      email: 'alice@libredb.test',
      name: 'Alice Admin',
      authProvider: 'keycloak',
      currentTenantId: 'tenant-install',
      membershipId: null,
      roles: ['PLATFORM_ADMIN'],
      permissions: ['connection.view'],
      accessibleTenants: [{ id: 'tenant-install', name: 'Acme', slug: 'default' }],
      directoryDegraded: true,
    })
  })
})
