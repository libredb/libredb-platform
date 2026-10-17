import { describe, expect, it } from 'vitest'
import {
  KEYCLOAK_PROXIED_URL,
  KEYCLOAK_URL,
  TEST_REALM,
  clientCredentialsToken,
  codeLogin,
  decodeJwtPayload,
} from './helpers/code-login'

// Runs against the keycloak and keycloak-proxied services of
// docker-compose.test.yml, which import tests/fixtures/keycloak/libredb-test-realm.json.

async function idTokenClaims(username: string): Promise<Record<string, unknown>> {
  const tokens = await codeLogin({ username })
  return decodeJwtPayload(tokens.id_token)
}

describe('Keycloak test realm', () => {
  it('an authorization-code login of alice with PKCE yields an ID token carrying email and libredb_roles [admin]', async () => {
    const claims = await idTokenClaims('alice')
    expect(claims.iss).toBe(`${KEYCLOAK_URL}/realms/${TEST_REALM}`)
    expect(claims.sub).toBe('00000000-0000-4000-8000-00000000a11c')
    expect(claims.email).toBe('alice@libredb.test')
    expect(claims.libredb_roles).toEqual(['admin'])
  })

  it.each([
    ['grace', ['admin']],
    ['bob', ['user']],
    ['dave', ['user']],
  ])('an authorization-code login of %s yields libredb_roles %j', async (username, roles) => {
    const claims = await idTokenClaims(username)
    expect(claims.libredb_roles).toEqual(roles)
  })

  it('an authorization-code login of erin yields libredb_roles [user] through the subgroup', async () => {
    const claims = await idTokenClaims('erin')
    expect(claims.libredb_roles).toEqual(['user'])
  })

  it("carol's ID token carries no libredb_roles claim", async () => {
    const claims = await idTokenClaims('carol')
    expect(claims.email).toBe('carol@libredb.test')
    expect(claims).not.toHaveProperty('libredb_roles')
  })

  it('frank, who is disabled, cannot sign in', async () => {
    await expect(codeLogin({ username: 'frank' })).rejects.toThrow(/Login of frank answered 200/)
  })

  it('a libredb-platform service-account token gets 200 on GET /admin/realms/libredb/users and 403 on POST /admin/realms/libredb/users', async () => {
    const token = await clientCredentialsToken(KEYCLOAK_URL)
    const users = `${KEYCLOAK_URL}/admin/realms/${TEST_REALM}/users`

    const list = await fetch(users, { headers: { Authorization: `Bearer ${token}` } })
    expect(list.status).toBe(200)
    const usernames = ((await list.json()) as Array<{ username: string }>).map((user) => user.username)
    expect(usernames).toEqual(expect.arrayContaining(['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace']))

    const create = await fetch(users, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mallory', enabled: true }),
    })
    expect(create.status).toBe(403)
  })

  it('on keycloak-proxied, a client-credentials token requested at http://localhost:58081 is accepted by the Admin API at that URL', async () => {
    const token = await clientCredentialsToken(KEYCLOAK_PROXIED_URL)
    expect(decodeJwtPayload(token).iss).toBe(`https://auth.libredb.test/realms/${TEST_REALM}`)

    const list = await fetch(`${KEYCLOAK_PROXIED_URL}/admin/realms/${TEST_REALM}/users?max=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(list.status).toBe(200)
  })
})
