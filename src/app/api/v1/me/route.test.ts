// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from 'jose'
import { LicenseLimitError } from '@/shared/lib/errors'
import { IdentityProviderUnavailableError } from '@/shared/lib/bearer/errors'
import { PERMISSIONS, SYSTEM_ROLES } from '@/shared/lib/permissions'

const ISSUER = 'https://auth.example.test/realms/libredb'

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
const keys = vi.hoisted(() => ({ current: undefined as unknown }))
const admitInstallAdmin = vi.hoisted(() => vi.fn())
const provisionKeycloakUser = vi.hoisted(() => vi.fn())
const getInstallTenant = vi.hoisted(() => vi.fn())
const findUser = vi.hoisted(() => vi.fn())

vi.mock('@/shared/lib/runtime-config', () => ({ getRuntimeConfig: () => config.current }))
vi.mock('@/shared/lib/bearer/issuer-keys', () => ({
  getIssuerKeys: (issuer: string) => {
    if (issuer !== ISSUER) throw new Error(`unexpected issuer ${issuer}`)
    return keys.current
  },
}))
vi.mock('@/shared/lib/db', () => ({ db: { user: { findUnique: findUser } } }))
vi.mock('@/shared/lib/identity/install-admin', () => ({ admitInstallAdmin }))
vi.mock('@/shared/lib/identity/install-tenant', () => ({ getInstallTenant }))
vi.mock('@/shared/lib/identity/keycloak-provisioning', () => ({ provisionKeycloakUser }))

import { GET } from './route'

const SELF_HOSTED = {
  DEPLOYMENT_MODE: 'self-hosted',
  AUTH_KEYCLOAK_ISSUER: ISSUER,
  PLATFORM_ROLE_CLAIM: 'libredb_roles',
  PLATFORM_ADMIN_ROLE: 'admin',
  PLATFORM_API_AUDIENCE: 'libredb-platform-api',
  PLATFORM_API_CLIENT_IDS: ['libredb-mobile'],
}

let signingKey: CryptoKey
let localKeys: JWTVerifyGetKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  signingKey = pair.privateKey
  localKeys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256' }] })
})

beforeEach(() => {
  config.current = SELF_HOSTED
  keys.current = localKeys
  admitInstallAdmin.mockReset().mockResolvedValue(undefined)
  getInstallTenant.mockReset().mockResolvedValue({ id: 'tenant-install', name: 'Acme', slug: 'default', planConfig: {} })
  provisionKeycloakUser.mockReset().mockResolvedValue({ id: 'user-alice', email: 'alice@libredb.test', name: 'Alice Admin' })
  // The first call of an account: it has no Platform user yet.
  findUser.mockReset().mockResolvedValue(null)
})

function token(roles: string[] = ['admin']): Promise<string> {
  return new SignJWT({
    aud: ['libredb-studio-api', 'libredb-platform-api'],
    azp: 'libredb-mobile',
    email: 'alice@libredb.test',
    name: 'Alice Admin',
    libredb_roles: roles,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer(ISSUER)
    .setSubject('kc-alice')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey)
}

// The fields of a /api/v1 answer that these tests read: the user of a success, or the error contract.
type MeBody = Record<string, unknown> & { error: { code: string; message: string } }

async function get(authorization?: string): Promise<{ status: number; body: MeBody; headers: Headers }> {
  const headers = authorization === undefined ? undefined : { Authorization: authorization }
  const response = await GET(new Request('http://localhost:3100/api/v1/me', { headers }), { params: Promise.resolve({}) })
  return { status: response.status, body: await response.json(), headers: response.headers }
}

describe('GET /api/v1/me', () => {
  it('answers the Platform user of an admin token, with the rights of a Keycloak web session in the install tenant', async () => {
    const { status, body } = await get(`Bearer ${await token()}`)

    expect(status).toBe(200)
    expect(body).toEqual({
      id: 'user-alice',
      email: 'alice@libredb.test',
      name: 'Alice Admin',
      roles: [SYSTEM_ROLES.PLATFORM_ADMIN],
      permissions: Object.values(PERMISSIONS),
      tenant: { id: 'tenant-install', name: 'Acme', slug: 'default' },
    })
    // The first call of an account takes its admin seat before its user is provisioned, as the web sign-in does.
    expect(admitInstallAdmin).toHaveBeenCalledWith(expect.objectContaining({ sub: 'kc-alice', email: 'alice@libredb.test' }))
    expect(provisionKeycloakUser).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sub: 'kc-alice' }))
    expect(admitInstallAdmin.mock.invocationCallOrder[0]).toBeLessThan(provisionKeycloakUser.mock.invocationCallOrder[0])
  })

  it('reads the Platform user of a later call without writing it, so a call never moves its last sign-in', async () => {
    findUser.mockResolvedValue({ id: 'user-alice', email: 'alice@old.test', name: 'Alice' })

    const { status, body } = await get(`Bearer ${await token()}`)

    expect(status).toBe(200)
    expect(body).toMatchObject({ id: 'user-alice', email: 'alice@old.test', name: 'Alice' })
    expect(findUser).toHaveBeenCalledWith({ where: { keycloakId: 'kc-alice' }, select: { id: true, email: true, name: true } })
    expect(provisionKeycloakUser).not.toHaveBeenCalled()
  })

  it('answers 401 BEARER_INVALID with the invalid_token challenge, as JSON, for a request without a token', async () => {
    for (const authorization of [undefined, '', 'Basic YWxpY2U6c2VjcmV0', 'Bearer']) {
      const { status, body, headers } = await get(authorization)

      expect(status, String(authorization)).toBe(401)
      expect(body.error.code).toBe('BEARER_INVALID')
      expect(headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
    }
    expect(admitInstallAdmin).not.toHaveBeenCalled()
  })

  it('answers 401 BEARER_INVALID for a token that fails verification', async () => {
    const { status, body } = await get(`Bearer ${(await token()).slice(0, -4)}AAAA`)

    expect(status).toBe(401)
    expect(body.error.code).toBe('BEARER_INVALID')
  })

  it('answers 403 ADMIN_ROLE_REQUIRED for a token without the admin role, before any admission', async () => {
    const { status, body } = await get(`Bearer ${await token(['user'])}`)

    expect(status).toBe(403)
    expect(body).toEqual({ error: { code: 'ADMIN_ROLE_REQUIRED', message: 'The account lacks the Platform admin role' } })
    expect(admitInstallAdmin).not.toHaveBeenCalled()
  })

  it('answers 403 with the license code when the admission refuses a seat, and provisions no user', async () => {
    admitInstallAdmin.mockRejectedValue(new LicenseLimitError('LICENSE_ADMIN_SEATS'))

    const { status, body } = await get(`Bearer ${await token()}`)

    expect(status).toBe(403)
    expect(body.error.code).toBe('LICENSE_ADMIN_SEATS')
    expect(provisionKeycloakUser).not.toHaveBeenCalled()
  })

  it('answers 503 IDENTITY_PROVIDER_UNAVAILABLE when the keys of the issuer cannot be read', async () => {
    keys.current = (async () => {
      throw new IdentityProviderUnavailableError()
    }) as JWTVerifyGetKey

    const { status, body, headers } = await get(`Bearer ${await token()}`)

    expect(status).toBe(503)
    expect(body.error.code).toBe('IDENTITY_PROVIDER_UNAVAILABLE')
    expect(headers.get('www-authenticate')).toBeNull()
  })

  it('answers 404 API_DISABLED in cloud mode and without PLATFORM_API_AUDIENCE, whatever the token', async () => {
    const valid = `Bearer ${await token()}`
    for (const current of [
      { DEPLOYMENT_MODE: 'cloud', PLATFORM_API_AUDIENCE: 'libredb-platform-api', PLATFORM_API_CLIENT_IDS: ['libredb-mobile'] },
      { ...SELF_HOSTED, PLATFORM_API_AUDIENCE: undefined, PLATFORM_API_CLIENT_IDS: undefined },
    ]) {
      config.current = current
      for (const authorization of [valid, undefined]) {
        const { status, body } = await get(authorization)

        expect(status).toBe(404)
        expect(body.error.code).toBe('API_DISABLED')
      }
    }
  })
})
