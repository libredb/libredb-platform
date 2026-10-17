import { describe, expect, it } from 'vitest'
import { KEYCLOAK_URL, TEST_CLIENTS, TEST_REALM } from '../../../../../tests/keycloak/helpers/code-login'
import { createKeycloakAdminClient } from '@/shared/lib/keycloak/admin-client'
import { keycloakAdminConfig } from '@/shared/lib/keycloak/config'
import { createKeycloakDirectory } from '@/shared/lib/keycloak/directory'
import {
  createDirectorySyncTask,
  type DirectoryMemberState,
  type DirectoryRevocation,
  type DirectorySnapshotStore,
  type DirectorySyncChange,
} from './directory-sync'

// Runs against the keycloak service of docker-compose.test.yml, which imports
// tests/fixtures/keycloak/libredb-test-realm.json: bob holds the client role user of libredb directly.
// The test changes bob's roles in that shared realm, which other integration files read, so
// vitest.integration.config.ts runs the files one at a time and the test gives bob his role back however it ends.

const BOB = '00000000-0000-4000-8000-000000000b0b'

const directory = createKeycloakDirectory(
  createKeycloakAdminClient(
    keycloakAdminConfig({
      AUTH_KEYCLOAK_ISSUER: `${KEYCLOAK_URL}/realms/${TEST_REALM}`,
      AUTH_KEYCLOAK_ID: TEST_CLIENTS.platform.clientId,
      AUTH_KEYCLOAK_SECRET: TEST_CLIENTS.platform.clientSecret,
    }),
  ),
)

/**
 * Calls the Admin REST API of the fixture realm as the master administrator that docker-compose.test.yml bootstraps,
 * because the service account of libredb-platform may only read.
 */
async function asRealmAdmin(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
  const token = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' }),
  })
  if (!token.ok) throw new Error(`The Keycloak master administrator could not sign in: HTTP ${token.status}`)
  const { access_token: accessToken } = (await token.json()) as { access_token: string }
  const response = await fetch(`${KEYCLOAK_URL}/admin/realms/${TEST_REALM}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Keycloak Admin REST ${method} ${path} answered HTTP ${response.status}`)
  return response
}

/** Adds or removes bob's direct mapping of the client role user of libredb. */
async function setBobsUserRole(method: 'POST' | 'DELETE'): Promise<void> {
  const clients = (await (await asRealmAdmin('GET', '/clients?clientId=libredb')).json()) as Array<{ id: string; clientId: string }>
  const client = clients.find(candidate => candidate.clientId === 'libredb')
  if (!client) throw new Error('The fixture realm has no client libredb')
  const role: unknown = await (await asRealmAdmin('GET', `/clients/${client.id}/roles/user`)).json()
  await asRealmAdmin(method, `/users/${BOB}/role-mappings/clients/${client.id}`, [role])
}

/** The snapshot and the revocations, kept in memory: the database side is directory-sync.db.test.ts. */
class MemoryStore implements DirectorySnapshotStore {
  members = new Map<string, DirectoryMemberState>()
  readonly revocations: DirectoryRevocation[] = []

  async read(): Promise<DirectoryMemberState[]> {
    return [...this.members.values()]
  }

  async commit({ revocations, added, changed, removed }: DirectorySyncChange): Promise<void> {
    this.revocations.push(...revocations)
    for (const subject of removed) this.members.delete(subject)
    for (const member of [...changed, ...added]) this.members.set(member.subject, member)
  }
}

describe('directory sync against Keycloak', () => {
  it("removing bob's user role in the fixture realm makes the next run write role-removed for bob", async () => {
    const store = new MemoryStore()
    const task = createDirectorySyncTask({
      config: () => ({
        DEPLOYMENT_MODE: 'self-hosted',
        PLATFORM_ADMIN_ROLE: 'admin',
        STUDIO_USER_ROLE: 'user',
        DIRECTORY_SYNC_INTERVAL_SEC: 60,
      }),
      directory: () => directory,
      store,
    })

    await task.run({ state: null })
    expect(store.revocations).toEqual([])
    const seeded = [...store.members.values()].map(({ username, roles, enabled }) => ({ username, roles, enabled }))
    expect(seeded.sort((left, right) => left.username.localeCompare(right.username))).toEqual([
      { username: 'alice', roles: ['admin'], enabled: true },
      { username: 'bob', roles: ['user'], enabled: true },
      { username: 'dave', roles: ['user'], enabled: true },
      { username: 'erin', roles: ['user'], enabled: true },
      { username: 'frank', roles: ['user'], enabled: false },
      { username: 'grace', roles: ['admin'], enabled: true },
    ])

    await setBobsUserRole('DELETE')
    try {
      await task.run({ state: null })
      expect(store.revocations).toEqual([{ subject: BOB, reason: 'role-removed' }])
      expect(store.members.has(BOB)).toBe(false)
    } finally {
      await setBobsUserRole('POST')
    }
    expect((await directory.listRoleMembers('user')).map(member => member.id)).toContain(BOB)
  })
})
