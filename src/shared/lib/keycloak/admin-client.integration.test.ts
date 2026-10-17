import { describe, expect, it } from 'vitest'
import {
  KEYCLOAK_PROXIED_URL,
  KEYCLOAK_URL,
  TEST_CLIENTS,
  TEST_REALM,
} from '../../../../tests/keycloak/helpers/code-login'
import { createKeycloakAdminClient, type KeycloakAdminClient } from './admin-client'
import { keycloakAdminConfig } from './config'
import { KeycloakNotFoundError, KeycloakPermissionError } from './errors'

// Runs against the keycloak and keycloak-proxied services of docker-compose.test.yml, which import
// tests/fixtures/keycloak/libredb-test-realm.json. The libredb-platform service account holds only the
// realm-management roles view-users and view-clients there, as the installer configures it.

const FIXTURE_USERNAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace']

function clientFor(issuer: string, adminUrl: string): KeycloakAdminClient {
  return createKeycloakAdminClient(
    keycloakAdminConfig({
      AUTH_KEYCLOAK_ISSUER: issuer,
      AUTH_KEYCLOAK_ID: TEST_CLIENTS.platform.clientId,
      AUTH_KEYCLOAK_SECRET: TEST_CLIENTS.platform.clientSecret,
      KEYCLOAK_ADMIN_URL: adminUrl,
    }),
  )
}

// keycloak serves its issuer on localhost, so the loopback address is another URL for the same server.
function loopbackUrl(url: string): string {
  const loopback = new URL(url)
  loopback.hostname = '127.0.0.1'
  return loopback.origin
}

async function usernames(client: KeycloakAdminClient): Promise<string[]> {
  const users = await client.getPaged<{ username: string }>('/users', { briefRepresentation: true })
  return users.map(user => user.username).sort()
}

describe('Keycloak Admin API client', () => {
  it('with KEYCLOAK_ADMIN_URL=http://127.0.0.1:58080 and the issuer on localhost, a paged user listing succeeds', async () => {
    const client = clientFor(`${KEYCLOAK_URL}/realms/${TEST_REALM}`, loopbackUrl(KEYCLOAK_URL))

    expect(await usernames(client)).toEqual(FIXTURE_USERNAMES)
  })

  it('against keycloak-proxied, with KEYCLOAK_ADMIN_URL=http://localhost:58081 and the issuer https://auth.libredb.test/realms/libredb, a paged user listing succeeds', async () => {
    const client = clientFor(`https://auth.libredb.test/realms/${TEST_REALM}`, KEYCLOAK_PROXIED_URL)

    expect(await usernames(client)).toEqual(FIXTURE_USERNAMES)
  })

  it('view-clients reads the libredb client, and the answers of Keycloak classify as KeycloakNotFoundError and KeycloakPermissionError', async () => {
    const client = clientFor(`${KEYCLOAK_URL}/realms/${TEST_REALM}`, loopbackUrl(KEYCLOAK_URL))

    const clients = await client.get<Array<{ clientId: string }>>('/clients', { clientId: 'libredb' })
    expect(clients.map(found => found.clientId)).toEqual(['libredb'])

    await expect(client.get('/users/00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(KeycloakNotFoundError)
    // Realm roles need view-realm, which the service account does not hold.
    await expect(client.get('/roles')).rejects.toBeInstanceOf(KeycloakPermissionError)
  })
})
