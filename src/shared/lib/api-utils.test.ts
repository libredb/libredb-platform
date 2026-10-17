import { describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => vi.fn())

// getApiUser reads the session payload that the session callback of auth-callbacks.ts builds.
vi.mock('./auth', () => ({ auth: () => auth() }))

import { getApiUser } from './api-utils'

describe('getApiUser', () => {
  it('carries the authProvider and directoryDegraded of the session', async () => {
    auth.mockResolvedValue({
      user: { id: 'user-bob', email: 'bob@example.com', name: 'Bob User' },
      expires: '2026-10-23T08:00:00.000Z',
      authProvider: 'credentials',
      currentTenantId: 'tenant-acme',
      membershipId: 'membership-acme',
      roles: ['TENANT_EDITOR'],
      permissions: ['connection.view'],
      accessibleTenants: [{ id: 'tenant-acme', name: 'Acme', slug: 'acme' }],
      directoryDegraded: false,
    })

    await expect(getApiUser()).resolves.toEqual({
      id: 'user-bob',
      email: 'bob@example.com',
      name: 'Bob User',
      authProvider: 'credentials',
      currentTenantId: 'tenant-acme',
      membershipId: 'membership-acme',
      roles: ['TENANT_EDITOR'],
      permissions: ['connection.view'],
      accessibleTenants: [{ id: 'tenant-acme', name: 'Acme', slug: 'acme' }],
      directoryDegraded: false,
    })
  })
})
