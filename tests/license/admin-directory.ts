import { vi } from 'vitest'
import type { AdminSeatDirectory } from '../../src/shared/lib/license/admin-seats'
import { KeycloakNotFoundError } from '../../src/shared/lib/keycloak/errors'

// The two reads of the Keycloak directory that the admin seats make, over accounts kept in memory, for the tests that
// count admin seats without a Keycloak server. tests/fixtures/keycloak/libredb-test-realm.json and the integration
// tests stand for the real realm.

/** A Keycloak account: whether Keycloak lets it sign in, and the names of every role it holds by any path. */
export interface KeycloakAccount {
  enabled: boolean
  roles: string[]
}

/**
 * A directory over `accounts`, keyed by Keycloak user id, which a test may change between reads. Each read is pushed
 * onto `calls` as `<method> <id>`, so a test can see what Keycloak was asked and in which order.
 */
export function fakeAdminDirectory(accounts: Record<string, KeycloakAccount>, calls: string[] = []) {
  return {
    calls,
    getUser: vi.fn<AdminSeatDirectory['getUser']>(async (id) => {
      calls.push(`getUser ${id}`)
      const account = accounts[id]
      if (account === undefined) return null
      return { id, username: id, email: null, firstName: null, lastName: null, enabled: account.enabled }
    }),
    getEffectiveRoles: vi.fn<AdminSeatDirectory['getEffectiveRoles']>(async (id) => {
      calls.push(`getEffectiveRoles ${id}`)
      const account = accounts[id]
      // Keycloak answers its own 404 for the role mappings of a user it does not have.
      if (account === undefined) {
        throw new KeycloakNotFoundError('Keycloak Admin API GET /users/{id}/role-mappings/clients/{id}/composite answered 404')
      }
      return [...account.roles]
    }),
  }
}
