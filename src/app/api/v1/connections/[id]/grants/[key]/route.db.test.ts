import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectStudio, connectSuperuser, fixtureUrl } from '../../../../../../../../tests/db/connect'
import { sealSecret, type CredentialSet } from '@/shared/lib/sealing/lsb1'

// The grant routes of the bearer API on PostgreSQL, behind the real withBearer: a token signed by a local key, the
// Platform user and the install tenant of this file, and a Keycloak directory that knows bob.

// Every row of this file carries this marker in its ids, so the cleanup removes exactly them.
const ids = vi.hoisted(() => {
  const marker = `api-grants-${crypto.randomUUID().slice(0, 8)}`
  return { marker, tenant: `${marker}-tenant`, bob: crypto.randomUUID() }
})
const PLAN_ID = `${ids.marker}-plan`
const TENANT_ID = ids.tenant
const ACTOR_ID = `${ids.marker}-actor`
const ACTOR_KEYCLOAK_ID = randomUUID()
const BOB = ids.bob
const DAY_MS = 24 * 60 * 60 * 1000

const ISSUER = vi.hoisted(() => 'https://auth.example.test/realms/libredb')
const keys = vi.hoisted(() => ({ current: undefined as unknown }))

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
// The admin seat of the actor, which the bearer tests cover, is taken already.
vi.mock('@/shared/lib/identity/install-admin', () => ({ admitInstallAdmin: async () => undefined }))
vi.mock('@/shared/lib/identity/install-tenant', () => ({
  getInstallTenant: async () => ({ id: ids.tenant, name: 'A', slug: ids.tenant }),
}))
vi.mock('@/shared/lib/auth-utils', async () => (await import('../../../../../../../../tests/api/fake-bearer')).fakeAuthUtilsModule())
vi.mock('@/shared/lib/keycloak/directory', () => ({
  getKeycloakDirectory: () => ({
    getUser: async (id: string) =>
      id === ids.bob
        ? { id, username: 'bob', email: 'bob@libredb.test', firstName: null, lastName: null, enabled: true }
        : null,
  }),
}))
// Cloud-like ungated writes: the seat gates have their own database tests (license-gates.db.test.ts).
vi.mock('@/shared/lib/license/install-license', () => ({ getLicenseStatus: () => null }))

const VECTORS_FILE = path.resolve(__dirname, '../../../../../../../../tests/fixtures/governance/lsb1-vectors.json')
const CANARY = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors.find(
  (vector: { id: string }) => vector.id === 'canary',
) as { recipientPublicKey: string }
const PUBLIC_KEY = Buffer.from(CANARY.recipientPublicKey, 'base64url')
const READ: CredentialSet = { user: 'orders_reader', password: 'read-pass-1' }
const DEFINITION = { host: 'db.internal', port: 5432, database: 'orders' }

describe('the grant routes of /api/v1 on PostgreSQL', () => {
  let route: typeof import('./route')
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client
  let studio: Client
  let signingKey: CryptoKey
  let connectionId: string
  let otherConnectionId: string

  function token(): Promise<string> {
    return new SignJWT({
      aud: ['libredb-studio-api', 'libredb-platform-api'],
      azp: 'libredb-mobile',
      email: 'probe@libredb.test',
      libredb_roles: ['admin'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(ISSUER)
      .setSubject(ACTOR_KEYCLOAK_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey)
  }

  async function newConnection(): Promise<string> {
    const { DatabaseConnectionRepository } = await import('@/features/connections/lib/database-connection.repository')
    const id = randomUUID()
    const readSecret = sealSecret(
      { connectionId: id, level: 'read', engine: 'postgres', definition: DEFINITION, plaintext: READ },
      PUBLIC_KEY,
    )
    await DatabaseConnectionRepository.create(
      TENANT_ID,
      ACTOR_ID,
      'web',
      {
        id,
        name: 'Orders',
        engine: 'postgres',
        environment: null,
        groupName: null,
        color: null,
        mcpEnabled: false,
        definition: DEFINITION,
        readSecret,
        writeSecret: null,
      },
      null,
    )
    return id
  }

  async function call(method: 'PUT' | 'DELETE', connection: string, key: string, body?: unknown) {
    const request = new Request(`http://localhost:3100/api/v1/connections/${connection}/grants/${key}`, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return route[method](request, { params: Promise.resolve({ id: connection, key }) })
  }

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    const pair = await generateKeyPair('RS256', { extractable: true })
    signingKey = pair.privateKey
    keys.current = createLocalJWKSet({
      keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256' }],
    }) as JWTVerifyGetKey
    ;({ db } = await import('@/shared/lib/db'))
    route = await import('./route')
    superuser = await connectSuperuser()
    studio = await connectStudio()

    await superuser.query(`INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, $1, 'Probe', now())`, [PLAN_ID])
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'A', $1, $2, now())`,
      [TENANT_ID, PLAN_ID],
    )
    await superuser.query(
      `INSERT INTO platform.users (id, "keycloakId", email, "updatedAt") VALUES ($1, $2, 'probe@libredb.test', now())`,
      [ACTOR_ID, ACTOR_KEYCLOAK_ID],
    )
    connectionId = await newConnection()
    otherConnectionId = await newConnection()
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.admin_actions WHERE "actorId" = $1', [ACTOR_ID])
    await superuser.query('DELETE FROM platform.database_connections WHERE "createdById" = $1', [ACTOR_ID])
    await superuser.query('DELETE FROM platform.users WHERE id = $1', [ACTOR_ID])
    await superuser.query('DELETE FROM platform.tenants WHERE id = $1', [TENANT_ID])
    await superuser.query('DELETE FROM platform.plan_configs WHERE id = $1', [PLAN_ID])
    await superuser.end()
    await studio.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('a grant set through the API appears in bridge.grants_v1 with one admin action on channel api, and a revoke removes it', async () => {
    const expiresAt = new Date(Date.now() + DAY_MS)
    const response = await call('PUT', connectionId, BOB, { level: 'read', expiresAt: expiresAt.toISOString() })

    expect(response.status).toBe(200)
    const { id } = (await response.json()) as { id: string }
    const { rows: published } = await studio.query(
      'SELECT subject, level, expires_at FROM bridge.grants_v1 WHERE connection_id = $1',
      [connectionId],
    )
    expect(published).toEqual([{ subject: BOB, level: 'read', expires_at: expiresAt }])
    const actions = async () =>
      (
        await superuser.query(
          `SELECT action, "targetId", channel::text AS channel FROM platform.admin_actions
           WHERE "targetType" = 'grant' AND "actorId" = $1 ORDER BY "createdAt", id`,
          [ACTOR_ID],
        )
      ).rows
    expect(await actions()).toEqual([{ action: 'grant.create', targetId: id, channel: 'api' }])

    // The path names the connection, so the grant cannot be revoked through another connection.
    const elsewhere = await call('DELETE', otherConnectionId, id)
    expect(elsewhere.status).toBe(404)
    expect(await actions()).toHaveLength(1)

    const revoked = await call('DELETE', connectionId, id)
    expect(revoked.status).toBe(204)
    const { rows: left } = await studio.query('SELECT 1 FROM bridge.grants_v1 WHERE connection_id = $1', [connectionId])
    expect(left).toEqual([])
    expect(await actions()).toEqual([
      { action: 'grant.create', targetId: id, channel: 'api' },
      { action: 'grant.revoke', targetId: id, channel: 'api' },
    ])
  })
})
