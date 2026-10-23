import { describe, it, expect } from 'vitest'
import { DirectoryUnavailableError, readDirectory, requireDirectory } from './directory-guard'
import { ForbiddenError } from './errors'
import { KeycloakUnavailableError } from './keycloak/errors'
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

describe('readDirectory', () => {
  it('answers the read, and turns a Keycloak that does not answer into DirectoryUnavailableError with its message', async () => {
    expect(await readDirectory(async () => 'users')).toBe('users')

    const unreachable = new KeycloakUnavailableError('Keycloak Admin API GET /users did not answer within 5 s')
    const refusal = await readDirectory(async () => {
      throw unreachable
    }).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(DirectoryUnavailableError)
    expect(refusal).toMatchObject({
      code: 'DIRECTORY_UNAVAILABLE',
      statusCode: 503,
      message: 'Keycloak Admin API GET /users did not answer within 5 s',
      cause: unreachable,
    })

    const other = new Error('boom')
    await expect(readDirectory(async () => {
      throw other
    })).rejects.toBe(other)
  })
})
