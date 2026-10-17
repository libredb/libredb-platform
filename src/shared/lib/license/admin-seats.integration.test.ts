import { describe, expect, it } from 'vitest'
import { KEYCLOAK_URL, TEST_CLIENTS, TEST_REALM } from '../../../../tests/keycloak/helpers/code-login'
import { createKeycloakAdminClient } from '../keycloak/admin-client'
import { keycloakAdminConfig } from '../keycloak/config'
import { createKeycloakDirectory } from '../keycloak/directory'
import { adminSeatState, identitiesWithoutAdminSeat } from './admin-seats'

// Runs against the keycloak service of docker-compose.test.yml, whose realm mirrors the one the installer converges:
// the admin seats read the users of tests/fixtures/keycloak/libredb-test-realm.json as the service account of
// libredb-platform, with the default PLATFORM_ADMIN_ROLE.

const USERS = {
  alice: '00000000-0000-4000-8000-00000000a11c',
  grace: '00000000-0000-4000-8000-000000009ace',
  bob: '00000000-0000-4000-8000-000000000b0b',
  frank: '00000000-0000-4000-8000-00000000f4a2',
  carol: '00000000-0000-4000-8000-00000000ca20',
} as const
// An id the realm does not have, which Keycloak answers with its own 404.
const UNKNOWN = '00000000-0000-4000-8000-000000000000'

const directory = createKeycloakDirectory(
  createKeycloakAdminClient(
    keycloakAdminConfig({
      AUTH_KEYCLOAK_ISSUER: `${KEYCLOAK_URL}/realms/${TEST_REALM}`,
      AUTH_KEYCLOAK_ID: TEST_CLIENTS.platform.clientId,
      AUTH_KEYCLOAK_SECRET: TEST_CLIENTS.platform.clientSecret,
    }),
  ),
)

describe('the admin seats with the test realm', () => {
  it.each([
    // alice holds admin directly, and grace through the group dba.
    ['alice', 'admin'],
    ['grace', 'admin'],
    // bob holds only user, carol holds no role, and frank's account is disabled.
    ['bob', 'role-removed'],
    ['carol', 'role-removed'],
    ['frank', 'disabled'],
  ] as const)('reports %s as %s', async (name, state) => {
    await expect(adminSeatState(directory, 'admin', USERS[name])).resolves.toBe(state)
  })

  it('reports an id that the realm does not have as missing', async () => {
    await expect(adminSeatState(directory, 'admin', UNKNOWN)).resolves.toBe('missing')
  })

  it('finds a seat for alice and grace only', async () => {
    await expect(identitiesWithoutAdminSeat(directory, 'admin', [...Object.values(USERS), UNKNOWN])).resolves.toEqual(
      new Set([USERS.bob, USERS.carol, USERS.frank, UNKNOWN]),
    )
  })
})
