import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectStudio, connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { listenBridge, type BridgeListener } from '../../../../tests/db/listen'
import { sealSecret, type CredentialSet } from '@/shared/lib/sealing/lsb1'
import type { GrantSetting } from './grant.repository'

// Every row of this file carries this marker in its ids, so the cleanup removes exactly them.
const MARKER = `grant-repository-${randomUUID().slice(0, 8)}`
const PLAN_ID = `${MARKER}-plan`
const TENANT_A = `${MARKER}-tenant-a`
const TENANT_B = `${MARKER}-tenant-b`
// The Platform user of the acting admin, keyed by a Keycloak id as the sign-in provisions it.
const ACTOR_ID = `${MARKER}-actor`
const ACTOR_KEYCLOAK_ID = randomUUID()

const DAY_MS = 24 * 60 * 60 * 1000

// A published test key of Studio's lsb1 vectors, which protects nothing.
const VECTORS_FILE = path.resolve(__dirname, '../../../../tests/fixtures/governance/lsb1-vectors.json')
const CANARY = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors.find(
  (vector: { id: string }) => vector.id === 'canary',
) as { recipientPublicKey: string }
const PUBLIC_KEY = Buffer.from(CANARY.recipientPublicKey, 'base64url')

// The writes of this file pass no license status, as in cloud mode; license-gates.db.test.ts tests their seat gates.
const UNGATED = null

const READ: CredentialSet = { user: 'orders_reader', password: 'read-pass-1' }
const WRITE: CredentialSet = { user: 'orders_writer', password: 'write-pass-1' }
const DEFINITION = { host: 'db.internal', port: 5432, database: 'orders' }

function seal(id: string, level: 'read' | 'write', plaintext: CredentialSet) {
  return sealSecret({ connectionId: id, level, engine: 'postgres', definition: DEFINITION, plaintext }, PUBLIC_KEY)
}

function setting(connectionId: string, subject: string, overrides: Partial<GrantSetting> = {}): GrantSetting {
  return {
    connectionId,
    subject,
    subjectUsername: 'bob',
    subjectEmail: 'bob@libredb.test',
    level: 'read',
    expiresAt: null,
    ...overrides,
  }
}

describe('ConnectionGrantRepository on PostgreSQL', () => {
  let grants: typeof import('./grant.repository').ConnectionGrantRepository
  let connections: typeof import('./database-connection.repository').DatabaseConnectionRepository
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client
  let studio: Client
  let listener: BridgeListener

  // A connection of tenant A with a read and a write credential, created as Platform creates one.
  async function newConnection(): Promise<string> {
    const id = randomUUID()
    await connections.create(
      TENANT_A,
      ACTOR_ID,
      {
        id,
        name: 'Orders',
        engine: 'postgres',
        environment: null,
        groupName: null,
        color: null,
        mcpEnabled: false,
        definition: DEFINITION,
        readSecret: seal(id, 'read', READ),
        writeSecret: seal(id, 'write', WRITE),
      },
      UNGATED,
    )
    return id
  }

  // What Studio reads of the connection's grants.
  async function published(connectionId: string) {
    const { rows } = await studio.query(
      'SELECT subject, level, expires_at, downgraded FROM bridge.grants_v1 WHERE connection_id = $1 ORDER BY subject',
      [connectionId],
    )
    return rows
  }

  async function stored(connectionId: string) {
    const { rows } = await superuser.query(
      `SELECT id, subject, "subjectUsername", "subjectEmail", level, "expiresAt", "grantedById", "grantedAt"
       FROM platform.connection_grants WHERE "connectionId" = $1 ORDER BY subject`,
      [connectionId],
    )
    return rows
  }

  async function grantActions(connectionId: string) {
    const { rows } = await superuser.query(
      `SELECT action, "targetId", before, after FROM platform.admin_actions
       WHERE "targetType" = 'grant' AND coalesce(after, before)->>'connectionId' = $1 ORDER BY "createdAt", id`,
      [connectionId],
    )
    return rows
  }

  beforeAll(async () => {
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    ;({ ConnectionGrantRepository: grants } = await import('./grant.repository'))
    ;({ DatabaseConnectionRepository: connections } = await import('./database-connection.repository'))
    superuser = await connectSuperuser()
    studio = await connectStudio()
    listener = await listenBridge()

    await superuser.query(`INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, $1, 'Probe', now())`, [PLAN_ID])
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'A', $1, $3, now()), ($2, 'B', $2, $3, now())`,
      [TENANT_A, TENANT_B, PLAN_ID],
    )
    await superuser.query(
      `INSERT INTO platform.users (id, "keycloakId", email, "updatedAt") VALUES ($1, $2, 'probe@libredb.test', now())`,
      [ACTOR_ID, ACTOR_KEYCLOAK_ID],
    )
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.admin_actions WHERE "actorId" = $1', [ACTOR_ID])
    // The grants go with their connections, by the foreign key's cascade.
    await superuser.query('DELETE FROM platform.database_connections WHERE "createdById" = $1', [ACTOR_ID])
    await superuser.query('DELETE FROM platform.users WHERE id = $1', [ACTOR_ID])
    await superuser.query('DELETE FROM platform.tenants WHERE id IN ($1, $2)', [TENANT_A, TENANT_B])
    await superuser.query('DELETE FROM platform.plan_configs WHERE id = $1', [PLAN_ID])
    await listener.close()
    await superuser.end()
    await studio.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('set writes a grant that bridge.grants_v1 publishes, and a second set replaces it, each with its admin action', async () => {
    const connectionId = await newConnection()
    const bob = randomUUID()
    await listener.flush()

    const granted = new Date(Date.now() - 1_000)
    const { id } = await grants.set(TENANT_A, ACTOR_ID, setting(connectionId, bob), granted, UNGATED)

    expect(await listener.flush()).toEqual([{ v: 1, kind: 'grants' }])
    expect(await published(connectionId)).toEqual([{ subject: bob, level: 'read', expires_at: null, downgraded: false }])
    expect(await stored(connectionId)).toEqual([
      {
        id,
        subject: bob,
        subjectUsername: 'bob',
        subjectEmail: 'bob@libredb.test',
        level: 'read',
        expiresAt: null,
        grantedById: ACTOR_ID,
        grantedAt: granted,
      },
    ])

    const changed = new Date()
    const expiresAt = new Date(changed.getTime() + DAY_MS)
    const replaced = await grants.set(
      TENANT_A,
      ACTOR_ID,
      setting(connectionId, bob, { level: 'write', expiresAt, subjectEmail: null }),
      changed,
      UNGATED,
    )

    expect(replaced).toEqual({ id })
    expect(await published(connectionId)).toEqual([{ subject: bob, level: 'write', expires_at: expiresAt, downgraded: false }])
    expect(await stored(connectionId)).toEqual([
      expect.objectContaining({ id, level: 'write', expiresAt, subjectEmail: null, grantedAt: changed }),
    ])
    expect(await grantActions(connectionId)).toEqual([
      {
        action: 'grant.create',
        targetId: id,
        before: null,
        after: expect.objectContaining({ subject: bob, level: 'read', expiresAt: null, selfGrant: false }),
      },
      {
        action: 'grant.update',
        targetId: id,
        before: expect.objectContaining({ level: 'read', subjectEmail: 'bob@libredb.test' }),
        after: expect.objectContaining({ level: 'write', expiresAt: expiresAt.toISOString(), subjectEmail: null }),
      },
    ])
  })

  it("an expiry just after the grant time passes the CHECK, and a grant to the actor's own Keycloak id is a self-grant", async () => {
    const connectionId = await newConnection()
    const now = new Date()

    // The grant time is the time the action checked the expiry against, so the CHECK expiresAt > grantedAt holds.
    const own = setting(connectionId, ACTOR_KEYCLOAK_ID, {
      subjectUsername: 'probe',
      subjectEmail: 'probe@libredb.test',
      expiresAt: new Date(now.getTime() + 1),
    })
    await grants.set(TENANT_A, ACTOR_ID, own, now, UNGATED)

    expect(await grantActions(connectionId)).toEqual([
      expect.objectContaining({ action: 'grant.create', after: expect.objectContaining({ selfGrant: true }) }),
    ])
  })

  it('revoke deletes a grant of its own tenant only, and softDelete deletes the grants of the connection with it', async () => {
    const connectionId = await newConnection()
    const [bob, erin] = [randomUUID(), randomUUID()]
    const { id: bobGrant } = await grants.set(TENANT_A, ACTOR_ID, setting(connectionId, bob), new Date(), UNGATED)
    const { id: erinGrant } = await grants.set(
      TENANT_A,
      ACTOR_ID,
      setting(connectionId, erin, { subjectUsername: 'erin' }),
      new Date(),
      UNGATED,
    )
    await listener.flush()

    await expect(grants.revoke(TENANT_B, bobGrant, ACTOR_ID)).rejects.toThrow('Grant not found')
    expect(await published(connectionId)).toHaveLength(2)

    expect(await grants.revoke(TENANT_A, bobGrant, ACTOR_ID)).toEqual({ connectionId })

    expect(await listener.flush()).toEqual([{ v: 1, kind: 'grants' }])
    expect((await published(connectionId)).map((row) => row.subject)).toEqual([erin])
    await expect(grants.revoke(TENANT_A, bobGrant, ACTOR_ID)).rejects.toThrow('Grant not found')

    await connections.softDelete(TENANT_A, connectionId, ACTOR_ID)

    expect(await stored(connectionId)).toEqual([])
    const kinds = (await listener.flush()).map((payload) => (payload as { kind: string }).kind).sort()
    expect(kinds).toEqual(['connections', 'grants'])
    expect((await grantActions(connectionId)).map((action) => [action.action, action.targetId])).toEqual([
      ['grant.create', bobGrant],
      ['grant.create', erinGrant],
      ['grant.revoke', bobGrant],
      ['grant.revoke', erinGrant],
    ])
    // A grant on a deleted connection is gone with it.
    await expect(grants.revoke(TENANT_A, erinGrant, ACTOR_ID)).rejects.toThrow('Grant not found')
  })

  it('listForConnection lists the grants of a connection of the tenant by username with their granter, and none for another tenant', async () => {
    const connectionId = await newConnection()
    const now = new Date()
    const zoe = setting(connectionId, randomUUID(), { subjectUsername: 'zoe', subjectEmail: null })
    await grants.set(TENANT_A, ACTOR_ID, zoe, now, UNGATED)
    await grants.set(TENANT_A, ACTOR_ID, setting(connectionId, randomUUID(), { level: 'write' }), now, UNGATED)

    const listed = await grants.listForConnection(TENANT_A, connectionId)
    expect(listed.map((grant) => [grant.subjectUsername, grant.level])).toEqual([
      ['bob', 'write'],
      ['zoe', 'read'],
    ])
    expect(listed[0].grantedBy).toEqual({ name: null, email: 'probe@libredb.test' })
    expect(await grants.listForConnection(TENANT_B, connectionId)).toEqual([])
  })
})
