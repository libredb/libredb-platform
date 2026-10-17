import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectStudio, connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { sealSecret, type CredentialSet } from '@/shared/lib/sealing/lsb1'
import type { NewDatabaseConnection } from './database-connection.repository'

// Every row of this file carries this marker in its ids, so the cleanup removes exactly them.
const MARKER = `connection-repository-${randomUUID().slice(0, 8)}`
const PLAN_ID = `${MARKER}-plan`
const TENANT_A = `${MARKER}-tenant-a`
const TENANT_B = `${MARKER}-tenant-b`
const USER_ID = `${MARKER}-user`

// A published test key of Studio's lsb1 vectors, which protects nothing.
const VECTORS_FILE = path.resolve(__dirname, '../../../../tests/fixtures/governance/lsb1-vectors.json')
const CANARY = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors.find(
  (vector: { id: string }) => vector.id === 'canary',
) as { recipientPublicKey: string; kid: string }
const PUBLIC_KEY = Buffer.from(CANARY.recipientPublicKey, 'base64url')
const KID = CANARY.kid

// The writes of this file pass no license status, as in cloud mode; license-gates.db.test.ts tests their seat gates.
const UNGATED = null

const READ: CredentialSet = { user: 'orders_reader', password: 'read-pass-1' }
const WRITE: CredentialSet = { user: 'orders_writer', password: 'write-pass-1' }
const DEFINITION = { host: 'db.internal', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } }
const MOVED = { host: 'replica.internal', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } }

function seal(id: string, level: 'read' | 'write', definition: Record<string, unknown>, plaintext: CredentialSet) {
  return sealSecret({ connectionId: id, level, engine: 'postgres', definition, plaintext }, PUBLIC_KEY)
}

function newConnection(overrides: Partial<NewDatabaseConnection> = {}): NewDatabaseConnection {
  const id = overrides.id ?? randomUUID()
  return {
    id,
    name: 'Orders',
    engine: 'postgres',
    environment: 'production',
    groupName: 'Sales',
    color: '#1E88E5',
    mcpEnabled: false,
    definition: DEFINITION,
    readSecret: seal(id, 'read', DEFINITION, READ),
    writeSecret: seal(id, 'write', DEFINITION, WRITE),
    ...overrides,
  }
}

describe('DatabaseConnectionRepository on PostgreSQL', () => {
  let repository: typeof import('./database-connection.repository').DatabaseConnectionRepository
  let db: typeof import('@/shared/lib/db').db
  let superuser: Client
  let studio: Client

  async function published(id: string) {
    const { rows } = await studio.query(
      `SELECT connection_id, name, engine, group_name, definition, read_secret, write_secret
       FROM bridge.connections_v1 WHERE connection_id = $1`,
      [id],
    )
    return rows
  }

  async function adminActions(id: string) {
    const { rows } = await superuser.query(
      'SELECT action, "actorId", "targetType", before, after FROM platform.admin_actions WHERE "targetId" = $1 ORDER BY "createdAt", id',
      [id],
    )
    return rows
  }

  async function stored(id: string) {
    const { rows } = await superuser.query(
      'SELECT definition, "readSecret", "writeSecret", active, "deletedAt" FROM platform.database_connections WHERE id = $1',
      [id],
    )
    return rows[0]
  }

  beforeAll(async () => {
    // The runtime role, as Platform connects; the Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    ;({ DatabaseConnectionRepository: repository } = await import('./database-connection.repository'))
    superuser = await connectSuperuser()
    studio = await connectStudio()

    await superuser.query(`INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, $1, 'Probe', now())`, [PLAN_ID])
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'A', $1, $3, now()), ($2, 'B', $2, $3, now())`,
      [TENANT_A, TENANT_B, PLAN_ID],
    )
    await superuser.query(`INSERT INTO platform.users (id, email, "updatedAt") VALUES ($1, 'probe@libredb.test', now())`, [USER_ID])
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.admin_actions WHERE "actorId" = $1', [USER_ID])
    await superuser.query('DELETE FROM platform.database_connections WHERE "createdById" = $1', [USER_ID])
    await superuser.query('DELETE FROM platform.users WHERE id = $1', [USER_ID])
    await superuser.query('DELETE FROM platform.tenants WHERE id IN ($1, $2)', [TENANT_A, TENANT_B])
    await superuser.query('DELETE FROM platform.plan_configs WHERE id = $1', [PLAN_ID])
    await superuser.end()
    await studio.end()
    await db.$disconnect()
    vi.unstubAllEnvs()
  })

  it('create writes the connection with its admin action, and bridge.connections_v1 publishes it to Studio', async () => {
    const connection = newConnection({ writeSecret: null })

    expect(await repository.create(TENANT_A, USER_ID, connection, UNGATED)).toEqual({ id: connection.id })

    expect(await published(connection.id)).toEqual([
      {
        connection_id: connection.id,
        name: 'Orders',
        engine: 'postgres',
        group_name: 'Sales',
        definition: DEFINITION,
        read_secret: connection.readSecret,
        write_secret: null,
      },
    ])
    const actions = await adminActions(connection.id)
    expect(actions).toEqual([
      {
        action: 'connection.create',
        actorId: USER_ID,
        targetType: 'connection',
        before: null,
        after: expect.objectContaining({ engine: 'postgres', definition: DEFINITION, readKid: KID, writeKid: null }),
      },
    ])
    expect(JSON.stringify(actions)).not.toContain('lsb1.')
    expect(await repository.findById(TENANT_A, connection.id)).toMatchObject({
      hostSummary: 'db.internal:5432/orders',
      hasWriteCredential: false,
      readKid: KID,
    })
  })

  it('an update that seals again for a new definition passes the rebind trigger, and one that does not is refused with nothing recorded', async () => {
    const connection = newConnection()
    await repository.create(TENANT_A, USER_ID, connection, UNGATED)

    // A definition change that keeps the old read envelope is what the trigger refuses.
    await expect(
      repository.update(TENANT_A, connection.id, USER_ID, { definition: MOVED, writeSecret: null }, [], UNGATED),
    ).rejects.toThrow(/newly sealed read secret/)
    expect(await stored(connection.id)).toMatchObject({ definition: DEFINITION, readSecret: connection.readSecret })
    expect(await adminActions(connection.id)).toHaveLength(1)

    const readSecret = seal(connection.id, 'read', MOVED, READ)
    await repository.update(
      TENANT_A,
      connection.id,
      USER_ID,
      { engine: 'postgres', definition: MOVED, readSecret, writeSecret: null },
      ['read'],
      UNGATED,
    )

    expect(await published(connection.id)).toEqual([
      expect.objectContaining({ definition: MOVED, read_secret: readSecret, write_secret: null }),
    ])
    const [, update] = await adminActions(connection.id)
    expect(update).toMatchObject({
      action: 'connection.update',
      before: { definition: DEFINITION, writeKid: KID },
      after: { definition: MOVED, writeKid: null, resealed: ['read'] },
    })

    // A credential sealed again for the stored binding writes that binding back, which the trigger accepts.
    const rotated = seal(connection.id, 'read', MOVED, { ...READ, password: 'read-pass-2' })
    const binding = { engine: 'postgres', definition: MOVED, readSecret: rotated }
    await repository.update(TENANT_A, connection.id, USER_ID, binding, ['read'], UNGATED)
    expect(await stored(connection.id)).toMatchObject({ definition: MOVED, readSecret: rotated })
  })

  it('soft delete hides the connection from bridge.connections_v1, the finders and the plan count, and other tenants never reach it', async () => {
    const connection = newConnection()
    await repository.create(TENANT_A, USER_ID, connection, UNGATED)
    const count = await repository.countByTenant(TENANT_A)

    for (const attempt of [
      () => repository.findById(TENANT_B, connection.id),
      () => repository.update(TENANT_B, connection.id, USER_ID, { name: 'Taken over' }, [], UNGATED),
      () => repository.softDelete(TENANT_B, connection.id, USER_ID),
    ]) {
      await expect(attempt()).rejects.toThrow('Connection not found')
    }
    expect(await published(connection.id)).toHaveLength(1)

    await repository.softDelete(TENANT_A, connection.id, USER_ID)

    expect(await published(connection.id)).toEqual([])
    expect(await stored(connection.id)).toMatchObject({
      active: false,
      deletedAt: expect.any(Date),
      readSecret: connection.readSecret,
    })
    expect(await repository.countByTenant(TENANT_A)).toBe(count - 1)
    expect((await repository.findAllByTenant(TENANT_A)).map((found) => found.id)).not.toContain(connection.id)
    await expect(repository.findById(TENANT_A, connection.id)).rejects.toThrow('Connection not found')
    await expect(repository.softDelete(TENANT_A, connection.id, USER_ID)).rejects.toThrow('Connection not found')
    expect((await adminActions(connection.id)).map((action) => action.action)).toEqual([
      'connection.create',
      'connection.delete',
    ])
  })
})
