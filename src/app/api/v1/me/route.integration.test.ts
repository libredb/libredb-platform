import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KEYCLOAK_URL,
  TEST_CLIENTS,
  TEST_REALM,
  codeLogin,
  decodeJwtPayload,
} from '../../../../../tests/keycloak/helpers/code-login'

// Runs against the keycloak service of docker-compose.test.yml: real access tokens of the libredb-mobile client of
// tests/fixtures/keycloak/libredb-test-realm.json, checked against the JWKS that the realm's discovery document names.
// The admission and the Platform user, which need the database, stand in for themselves here.

const ISSUER = `${KEYCLOAK_URL}/realms/${TEST_REALM}`

const admitInstallAdmin = vi.hoisted(() => vi.fn())

vi.mock('@/shared/lib/runtime-config', () => ({
  getRuntimeConfig: () => ({
    DEPLOYMENT_MODE: 'self-hosted',
    AUTH_KEYCLOAK_ISSUER: ISSUER,
    PLATFORM_ROLE_CLAIM: 'libredb_roles',
    PLATFORM_ADMIN_ROLE: 'admin',
    PLATFORM_API_AUDIENCE: 'libredb-platform-api',
    PLATFORM_API_CLIENT_IDS: ['libredb-mobile'],
  }),
}))
vi.mock('@/shared/lib/db', () => ({ db: { user: { findUnique: async () => null } } }))
vi.mock('@/shared/lib/identity/install-admin', () => ({ admitInstallAdmin }))
vi.mock('@/shared/lib/identity/install-tenant', () => ({
  getInstallTenant: async () => ({ id: 'tenant-install', name: 'LibreDB Test', slug: 'default' }),
}))
vi.mock('@/shared/lib/identity/keycloak-provisioning', () => ({
  provisionKeycloakUser: async (_client: unknown, identity: { sub: string; email: string; name: string | null }) => ({
    id: `user-${identity.sub}`,
    email: identity.email,
    name: identity.name,
  }),
}))

import { GET } from './route'

async function me(accessToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request('http://localhost:3100/api/v1/me', { headers: { Authorization: `Bearer ${accessToken}` } })
  const response = await GET(request, { params: Promise.resolve({}) })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('GET /api/v1/me with real Keycloak tokens', () => {
  beforeEach(() => {
    admitInstallAdmin.mockReset().mockResolvedValue(undefined)
  })

  it('answers 200 for an access token of alice from the libredb-mobile client, which carries both API audiences', async () => {
    const { access_token } = await codeLogin({ username: 'alice', client: TEST_CLIENTS.mobile })
    const claims = decodeJwtPayload(access_token)
    expect(claims.azp).toBe('libredb-mobile')
    expect(claims.aud).toEqual(expect.arrayContaining(['libredb-studio-api', 'libredb-platform-api']))

    const { status, body } = await me(access_token)

    expect(status).toBe(200)
    expect(body).toMatchObject({
      id: 'user-00000000-0000-4000-8000-00000000a11c',
      email: 'alice@libredb.test',
      roles: ['PLATFORM_ADMIN'],
      tenant: { id: 'tenant-install', name: 'LibreDB Test', slug: 'default' },
    })
    expect(admitInstallAdmin).toHaveBeenCalledTimes(1)
  })

  it('answers 403 ADMIN_ROLE_REQUIRED for an access token of bob, who holds the user role only', async () => {
    const { access_token } = await codeLogin({ username: 'bob', client: TEST_CLIENTS.mobile })

    const { status, body } = await me(access_token)

    expect(status).toBe(403)
    expect(body).toMatchObject({ error: { code: 'ADMIN_ROLE_REQUIRED' } })
    expect(admitInstallAdmin).not.toHaveBeenCalled()
  })

  it('answers 401 BEARER_INVALID for an access token of alice from the libredb-platform client', async () => {
    const { access_token } = await codeLogin({ username: 'alice', client: TEST_CLIENTS.platform })

    const { status, body } = await me(access_token)

    expect(status).toBe(401)
    expect(body).toMatchObject({ error: { code: 'BEARER_INVALID' } })
    expect(admitInstallAdmin).not.toHaveBeenCalled()
  })
})
