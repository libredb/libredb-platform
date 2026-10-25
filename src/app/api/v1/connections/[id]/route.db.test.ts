import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectStudio, connectSuperuser, fixtureUrl } from '../../../../../../tests/db/connect'
import { sealSecret, type CredentialSet } from '@/shared/lib/sealing/lsb1'

// PATCH /api/v1/connections/{id} on PostgreSQL, behind the real withBearer: a token signed by a local key, the
// Platform user and the install tenant of this file, and a second tenant whose connection the route must not reach.

// Every row of this file carries this marker in its ids, so the cleanup removes exactly them.
const ids = vi.hoisted(() => {
  const marker = `api-connection-${crypto.randomUUID().slice(0, 8)}`
  return { marker, tenant: `${marker}-tenant` }
})
const PLAN_ID = `${ids.marker}-plan`
const TENANT_ID = ids.tenant
const OTHER_TENANT_ID = `${ids.marker}-other`
const ACTOR_ID = `${ids.marker}-actor`
const ACTOR_KEYCLOAK_ID = randomUUID()
const BOB = randomUUID()

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
vi.mock('@/shared/lib/auth-utils', async () => (await import('../../../../../../tests/api/fake-bearer')).fakeAuthUtilsModule())
// Cloud-like ungated writes: the seat gate of a reactivation has its own database tests (license-gates.db.test.ts).
vi.mock('@/shared/lib/license/install-license', () => ({ getLicenseStatus: () => null }))

const VECTORS_FILE = path.resolve(__dirname, '../../../../../../tests/fixtures/governance/lsb1-vectors.json')
const CANARY = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors.find(
  (vector: { id: string }) => vector.id === 'canary',
) as { recipientPublicKey: string }
const PUBLIC_KEY = Buffer.from(CANARY.recipientPublicKey, 'base64url')
const READ: CredentialSet = { user: 'orders_reader', password: 'read-pass-1' }
const DEFINITION = { host: 'db.internal', port: 5432, database: 'orders' }

describe('PATCH /api/v1/connections/{id} on PostgreSQL', () => {
  let route: typeof import('./route')
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client
  let studio: Client
  let signingKey: CryptoKey

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

  async function newConnection(tenantId: string): Promise<string> {
    const { DatabaseConnectionRepository } = await import('@/features/connections/lib/database-connection.repository')
    const id = randomUUID()
    const readSecret = sealSecret(
      { connectionId: id, level: 'read', engine: 'postgres', definition: DEFINITION, plaintext: READ },
      PUBLIC_KEY,
    )
    await DatabaseConnectionRepository.create(
      tenantId,
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

  async function patch(connection: string, body: unknown) {
    const request = new Request(`http://localhost:3100/api/v1/connections/${connection}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return route.PATCH(request, { params: Promise.resolve({ id: connection }) })
  }

  async function updates(connection: string) {
    const { rows } = await superuser.query(
      `SELECT channel::text AS channel, before, after FROM platform.admin_actions
       WHERE action = 'connection.update' AND "targetId" = $1 ORDER BY "createdAt", id`,
      [connection],
    )
    return rows as { channel: string; before: Record<string, unknown>; after: Record<string, unknown> }[]
  }

  async function published(connection: string) {
    const connections = await studio.query('SELECT connection_id FROM bridge.connections_v1 WHERE connection_id = $1', [connection])
    const grants = await studio.query('SELECT subject, level FROM bridge.grants_v1 WHERE connection_id = $1', [connection])
    return { connections: connections.rows.length, grants: grants.rows }
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
    for (const tenant of [TENANT_ID, OTHER_TENANT_ID]) {
      await superuser.query(
        `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'A', $1, $2, now())`,
        [tenant, PLAN_ID],
      )
    }
    await superuser.query(
      `INSERT INTO platform.users (id, "keycloakId", email, "updatedAt") VALUES ($1, $2, 'probe@libredb.test', now())`,
      [ACTOR_ID, ACTOR_KEYCLOAK_ID],
    )
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.admin_actions WHERE "actorId" = $1', [ACTOR_ID])
    await superuser.query('DELETE FROM platform.database_connections WHERE "createdById" = $1', [ACTOR_ID])
    await superuser.query('DELETE FROM platform.users WHERE id = $1', [ACTOR_ID])
    await superuser.query('DELETE FROM platform.tenants WHERE id = ANY($1)', [[TENANT_ID, OTHER_TENANT_ID]])
    await superuser.query('DELETE FROM platform.plan_configs WHERE id = $1', [PLAN_ID])
    await superuser.end()
    await studio.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('disables and enables a connection with one connection.update on channel api each, and keeps its grants', async () => {
    const { ConnectionGrantRepository } = await import('@/features/connections/lib/grant.repository')
    const connectionId = await newConnection(TENANT_ID)
    await ConnectionGrantRepository.set(
      TENANT_ID,
      ACTOR_ID,
      'web',
      { connectionId, subject: BOB, subjectUsername: 'bob', subjectEmail: null, level: 'read', expiresAt: null },
      new Date(),
      null,
    )
    expect(await published(connectionId)).toEqual({ connections: 1, grants: [{ subject: BOB, level: 'read' }] })

    const disabled = await patch(connectionId, { active: false })
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toEqual({
      id: connectionId,
      name: 'Orders',
      engine: 'postgres',
      status: 'inactive',
      hasWriteCredential: false,
    })
    expect(await published(connectionId)).toEqual({ connections: 0, grants: [] })
    // Disabling keeps the grant, which bridge.grants_v1 publishes again once the connection is active.
    const { rows: kept } = await superuser.query('SELECT subject FROM platform.connection_grants WHERE "connectionId" = $1', [
      connectionId,
    ])
    expect(kept).toEqual([{ subject: BOB }])
    const [first] = await updates(connectionId)
    expect(first).toMatchObject({
      channel: 'api',
      before: { name: 'Orders', engine: 'postgres', active: true, definition: DEFINITION },
      after: { name: 'Orders', engine: 'postgres', active: false, definition: DEFINITION },
    })

    // The value the connection already has changes nothing and records nothing.
    const again = await patch(connectionId, { active: false })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ status: 'inactive' })
    expect(await updates(connectionId)).toHaveLength(1)

    const enabled = await patch(connectionId, { active: true })
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toMatchObject({ id: connectionId, status: 'active' })
    expect(await published(connectionId)).toEqual({ connections: 1, grants: [{ subject: BOB, level: 'read' }] })
    const actions = await updates(connectionId)
    expect(actions).toHaveLength(2)
    expect(actions[1]).toMatchObject({ channel: 'api', before: { active: false }, after: { active: true } })
  })

  it('answers 404 for a connection of another tenant and for a deleted one, and changes neither', async () => {
    const { DatabaseConnectionRepository } = await import('@/features/connections/lib/database-connection.repository')
    const elsewhere = await newConnection(OTHER_TENANT_ID)
    const deleted = await newConnection(TENANT_ID)
    await DatabaseConnectionRepository.softDelete(TENANT_ID, deleted, ACTOR_ID, 'web')

    for (const connection of [elsewhere, deleted]) {
      const response = await patch(connection, { active: false })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Connection not found' } })
      expect(await updates(connection)).toEqual([])
    }
    const { rows } = await superuser.query('SELECT active FROM platform.database_connections WHERE id = $1', [elsewhere])
    expect(rows).toEqual([{ active: true }])
  })
})
