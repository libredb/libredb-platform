import { describe, it, expect } from 'vitest'
import { requireDirectory } from './directory-guard'
import { ForbiddenError } from './errors'
import type { CurrentUser } from '../types'

const INSTALL_TENANT = { id: 'tenant-install', name: 'Acme', slug: 'default' }

function keycloakAdmin(directoryDegraded: boolean): CurrentUser {
  return {
    id: 'user-alice',
    email: 'alice@libredb.test',
    name: 'Alice',
    authProvider: 'keycloak',
    currentTenantId: INSTALL_TENANT.id,
    membershipId: null,
    roles: ['PLATFORM_ADMIN'],
    permissions: [],
    accessibleTenants: [INSTALL_TENANT],
    directoryDegraded,
  }
}

describe('requireDirectory', () => {
  it('requireDirectory throws ForbiddenError while the session is degraded', () => {
    expect(() => requireDirectory(keycloakAdmin(true))).toThrow(ForbiddenError)
    expect(() => requireDirectory(keycloakAdmin(true))).toThrow(
      'Permission denied: the Keycloak directory is unreachable',
    )

    expect(() => requireDirectory(keycloakAdmin(false))).not.toThrow()
  })
})
