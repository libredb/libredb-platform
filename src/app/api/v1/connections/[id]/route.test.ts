// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from 'jose'
import { LicenseLimitError, NotFoundError } from '@/shared/lib/errors'

// The route behind the real withBearer: a token signed by a local key, and the repository and the license as fakes.

const ISSUER = 'https://auth.example.test/realms/libredb'

const keys = vi.hoisted(() => ({ current: undefined as unknown }))
const findById = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const license = vi.hoisted(() => ({ status: null as unknown }))

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
vi.mock('@/shared/lib/bearer/issuer-keys', () => ({ getIssuerKeys: () => keys.current }))
vi.mock('@/shared/lib/db', () => ({
  db: { user: { findUnique: async () => ({ id: 'user-alice', email: 'alice@libredb.test', name: 'Alice' }) } },
}))
vi.mock('@/shared/lib/identity/install-admin', () => ({ admitInstallAdmin: async () => undefined }))
vi.mock('@/shared/lib/identity/install-tenant', () => ({
  getInstallTenant: async () => ({ id: 'tenant-install', name: 'Acme', slug: 'default' }),
}))
vi.mock('@/shared/lib/identity/keycloak-provisioning', () => ({ provisionKeycloakUser: vi.fn() }))
vi.mock('@/shared/lib/auth-utils', async () => (await import('../../../../../../tests/api/fake-bearer')).fakeAuthUtilsModule())
vi.mock('@/shared/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/connections/lib/database-connection.repository', () => ({
  DatabaseConnectionRepository: { findById, update },
}))
vi.mock('@/shared/lib/license/install-license', () => ({ getLicenseStatus: () => license.status }))

import { SMALL_LICENSE_ACTIVE } from '../../../../../../tests/license/statuses'
import { PATCH } from './route'

let signingKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  signingKey = pair.privateKey
  keys.current = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256' }],
  }) as JWTVerifyGetKey
})

function token(roles: string[] = ['admin']): Promise<string> {
  return new SignJWT({
    aud: ['libredb-studio-api', 'libredb-platform-api'],
    azp: 'libredb-mobile',
    email: 'alice@libredb.test',
    libredb_roles: roles,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer(ISSUER)
    .setSubject('kc-alice')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey)
}

// A connection as the repository returns it, with the kids of its sealed credentials.
function view(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-orders',
    name: 'Orders',
    engine: 'postgres',
    environment: 'production',
    groupName: null,
    color: null,
    definition: { host: 'db.internal', port: 5432, database: 'orders' },
    hostSummary: 'db.internal:5432/orders',
    mcpEnabled: false,
    active: true,
    hasWriteCredential: true,
    readKid: 'kid-read',
    writeKid: 'kid-write',
    createdById: 'user-alice',
    createdAt: new Date('2027-01-01T00:00:00Z'),
    updatedAt: new Date('2027-01-01T00:00:00Z'),
    ...overrides,
  }
}

type Answer = { status: number; body: Record<string, unknown> & { error: { code: string; fieldErrors?: unknown } } }

async function patch(body: unknown, options: { id?: string; authorization?: string } = {}): Promise<Answer> {
  const id = options.id ?? 'conn-orders'
  const authorization = options.authorization ?? `Bearer ${await token()}`
  const response = await PATCH(
    new Request(`http://localhost:3100/api/v1/connections/${id}`, {
      method: 'PATCH',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  license.status = SMALL_LICENSE_ACTIVE
  findById.mockReset().mockResolvedValue(view())
  update.mockReset().mockImplementation(async (_tenant, _id, _actor, _channel, changes) => view(changes))
})

describe('PATCH /api/v1/connections/{id}', () => {
  it('disables an active connection, recorded on channel api, and answers it as GET /api/v1/connections lists it', async () => {
    const { status, body } = await patch({ active: false })

    expect(status).toBe(200)
    expect(body).toEqual({ id: 'conn-orders', name: 'Orders', engine: 'postgres', status: 'inactive', hasWriteCredential: true })
    expect(findById).toHaveBeenCalledWith('tenant-install', 'conn-orders')
    expect(update).toHaveBeenCalledWith(
      'tenant-install',
      'conn-orders',
      'user-alice',
      'api',
      { active: false },
      [],
      SMALL_LICENSE_ACTIVE,
    )
  })

  it('enables an inactive connection under the license of the install', async () => {
    findById.mockResolvedValue(view({ active: false, hasWriteCredential: false, writeKid: null }))
    update.mockResolvedValue(view({ active: true, hasWriteCredential: false, writeKid: null }))

    const { status, body } = await patch({ active: true })

    expect(status).toBe(200)
    expect(body).toEqual({ id: 'conn-orders', name: 'Orders', engine: 'postgres', status: 'active', hasWriteCredential: false })
    expect(update).toHaveBeenCalledWith(
      'tenant-install',
      'conn-orders',
      'user-alice',
      'api',
      { active: true },
      [],
      SMALL_LICENSE_ACTIVE,
    )
  })

  it('answers the value the connection already has with 200, and writes nothing', async () => {
    const enabled = await patch({ active: true })
    expect(enabled.status).toBe(200)
    expect(enabled.body).toEqual({ id: 'conn-orders', name: 'Orders', engine: 'postgres', status: 'active', hasWriteCredential: true })

    findById.mockResolvedValue(view({ active: false }))
    const disabled = await patch({ active: false })
    expect(disabled.status).toBe(200)
    expect(disabled.body).toMatchObject({ status: 'inactive' })

    expect(update).not.toHaveBeenCalled()
  })

  it('answers 404 NOT_FOUND for a connection the install tenant does not have, or a deleted one', async () => {
    findById.mockRejectedValue(new NotFoundError('Connection'))

    const { status, body } = await patch({ active: false }, { id: 'conn-elsewhere' })

    expect(status).toBe(404)
    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Connection not found' } })
    expect(findById).toHaveBeenCalledWith('tenant-install', 'conn-elsewhere')
    expect(update).not.toHaveBeenCalled()
  })

  it.each(['LICENSE_USER_SEATS', 'LICENSE_EXPIRED', 'LICENSE_INVALID'] as const)(
    'answers a seat refusal of the license on reactivation with 403 %s',
    async (code) => {
      findById.mockResolvedValue(view({ active: false }))
      update.mockRejectedValue(new LicenseLimitError(code))

      const { status, body } = await patch({ active: true })

      expect(status).toBe(403)
      expect(body).toEqual({ error: { code, message: expect.any(String) } })
    },
  )

  it('refuses a body without a boolean active, or with any other field, with 400 VALIDATION_FAILED', async () => {
    const missing = await patch({})
    expect(missing.status).toBe(400)
    expect(missing.body.error).toMatchObject({ code: 'VALIDATION_FAILED', fieldErrors: { active: [expect.any(String)] } })

    for (const value of ['false', 0, null]) {
      const wrong = await patch({ active: value })
      expect(wrong.status, JSON.stringify(value)).toBe(400)
      expect(wrong.body.error).toMatchObject({ code: 'VALIDATION_FAILED', fieldErrors: { active: [expect.any(String)] } })
    }

    // The route changes the switch only, so it can never reach a definition or a credential.
    for (const extra of [
      { name: 'Renamed' },
      { engine: 'mysql' },
      { definition: { host: 'elsewhere' } },
      { readCredential: { user: 'u', password: 'p' } },
      { mcpEnabled: true },
    ]) {
      const refused = await patch({ active: false, ...extra })
      expect(refused.status, Object.keys(extra)[0]).toBe(400)
      // A strict schema reports the fields it does not know on the body itself, the empty path.
      expect(refused.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        fieldErrors: { '': [`Unrecognized key: "${Object.keys(extra)[0]}"`] },
      })
    }

    const notJson = await patch('{active')
    expect(notJson.status).toBe(400)
    expect(notJson.body.error).toMatchObject({ code: 'VALIDATION_FAILED', fieldErrors: { body: [expect.any(String)] } })

    expect(findById).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('answers 401 BEARER_INVALID for a request without a valid token, and changes nothing', async () => {
    const missing = await patch({ active: false }, { authorization: '' })
    expect(missing.status).toBe(401)
    expect(missing.body.error.code).toBe('BEARER_INVALID')

    const forged = await patch({ active: false }, { authorization: `Bearer ${(await token()).slice(0, -4)}AAAA` })
    expect(forged.status).toBe(401)
    expect(forged.body.error.code).toBe('BEARER_INVALID')

    expect(update).not.toHaveBeenCalled()
  })

  it('answers 403 ADMIN_ROLE_REQUIRED for a token without the admin role, and changes nothing', async () => {
    const { status, body } = await patch({ active: false }, { authorization: `Bearer ${await token(['user'])}` })

    expect(status).toBe(403)
    expect(body).toEqual({ error: { code: 'ADMIN_ROLE_REQUIRED', message: 'The account lacks the Platform admin role' } })
    expect(update).not.toHaveBeenCalled()
  })
})
