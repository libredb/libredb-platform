import { describe, expect, it } from 'vitest'
import {
  KEYCLOAK_URL,
  TEST_CLIENTS,
  TEST_REALM,
  codeLogin,
  decodeJwtPayload,
} from '../../../../tests/keycloak/helpers/code-login'
import { createKeycloakAdminClient } from './admin-client'
import { keycloakAdminConfig } from './config'
import { createKeycloakDirectory, type DirectoryUser } from './directory'

// Runs against the keycloak service of docker-compose.test.yml, which imports
// tests/fixtures/keycloak/libredb-test-realm.json. As in the realm the installer converges, admin and
// user are client roles of the libredb client there, held directly or through a group or a subgroup, and the
// libredb-platform service account holds only the realm-management roles view-users and view-clients.

const ALICE = '00000000-0000-4000-8000-00000000a11c'
const ERIN = '00000000-0000-4000-8000-00000000e121'
const CAROL = '00000000-0000-4000-8000-00000000ca20'

const directory = createKeycloakDirectory(
  createKeycloakAdminClient(
    keycloakAdminConfig({
      AUTH_KEYCLOAK_ISSUER: `${KEYCLOAK_URL}/realms/${TEST_REALM}`,
      AUTH_KEYCLOAK_ID: TEST_CLIENTS.platform.clientId,
      AUTH_KEYCLOAK_SECRET: TEST_CLIENTS.platform.clientSecret,
    }),
  ),
)

function usernamesAndFlags(members: DirectoryUser[]): Array<{ username: string; enabled: boolean }> {
  return members
    .map(({ username, enabled }) => ({ username, enabled }))
    .sort((left, right) => left.username.localeCompare(right.username))
}

describe('Keycloak directory', () => {
  it('the members of user are bob, dave, erin and frank, with frank disabled', async () => {
    expect(usernamesAndFlags(await directory.listRoleMembers('user'))).toEqual([
      { username: 'bob', enabled: true },
      { username: 'dave', enabled: true },
      { username: 'erin', enabled: true },
      { username: 'frank', enabled: false },
    ])
  })

  it('the members of admin are alice and grace', async () => {
    expect(usernamesAndFlags(await directory.listRoleMembers('admin'))).toEqual([
      { username: 'alice', enabled: true },
      { username: 'grace', enabled: true },
    ])
  })

  it('the effective roles of erin include user and those of carol are empty', async () => {
    expect(await directory.getEffectiveRoles(ERIN)).toContain('user')
    expect(await directory.getEffectiveRoles(CAROL)).toEqual([])
  })

  it('getUserSessionIds lists the session of a code login by alice', async () => {
    const tokens = await codeLogin({ username: 'alice' })
    const sid = decodeJwtPayload(tokens.id_token).sid

    expect(sid).toEqual(expect.any(String))
    expect(await directory.getUserSessionIds(ALICE)).toContain(sid)
  })

  it('getUser returns erin, and null for an id that Keycloak does not know', async () => {
    expect(await directory.getUser(ERIN)).toEqual({
      id: ERIN,
      username: 'erin',
      email: 'erin@libredb.test',
      firstName: 'Erin',
      lastName: 'Junior',
      enabled: true,
    })
    expect(await directory.getUser('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('searchUsers pages through the users that countUsers counts', async () => {
    // Keycloak matches a prefix of the username, first name, last name or email: alice Admin and dave Analyst.
    expect(await directory.countUsers('a')).toBe(2)
    expect((await directory.searchUsers({ search: 'a', first: 0, max: 20 })).map(user => user.username))
      .toEqual(['alice', 'dave'])
    expect((await directory.searchUsers({ search: 'a', first: 1, max: 1 })).map(user => user.username))
      .toEqual(['dave'])
    // The service account of libredb-platform is no directory user.
    expect(await directory.countUsers()).toBe(7)
  })
})
