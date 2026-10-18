import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sealSecret, type CredentialSet } from '@/shared/lib/sealing/lsb1'

type Row = Record<string, unknown>
type Where = Record<string, unknown>

const caller = vi.hoisted(() => ({
  id: 'user-alice',
  email: 'alice@libredb.test',
  name: 'Alice',
  currentTenantId: 'tenant-1',
  membershipId: 'member-1',
  roles: ['TENANT_ADMIN'],
  permissions: ['connection.view', 'connection.create', 'connection.edit', 'connection.delete'] as string[],
  accessibleTenants: [],
}))

// An in-memory stand-in for the tables the action touches; $transaction runs its callback on the same tables and
// restores them when the callback throws, as a rolled back transaction would. `update` applies the rebind rule of the
// database trigger platform.database_connections_rebind(), so an update the database refuses fails here too.
// $queryRaw answers the statements of the seat gates over the same tables (tests/license/seat-statements.ts).
const { db, tables } = vi.hoisted(() => {
  const tables: { tenant: Row[]; databaseConnection: Row[]; connectionGrant: Row[]; adminAction: Row[] } = {
    tenant: [],
    databaseConnection: [],
    connectionGrant: [],
    adminAction: [],
  }
  const matches = (row: Row, where: Where) => Object.entries(where).every(([key, value]) => row[key] === value)
  // jsonb equality: objects compare by their members, whatever their key order.
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
  }
  const databaseConnection = {
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      const row = tables.databaseConnection.find((candidate) => matches(candidate, where))
      return row ? { ...row } : null
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const index = tables.databaseConnection.findIndex((row) => row.id === where.id)
      if (index < 0) throw new Error('Record to update not found')
      const old = tables.databaseConnection[index]
      const next: Row = { ...old, ...data, updatedAt: new Date() }
      if (next.engine !== old.engine || canonical(next.definition) !== canonical(old.definition)) {
        if (next.readSecret === old.readSecret) {
          throw new Error(`connection ${old.id}: changing id, engine or definition requires a newly sealed read secret`)
        }
        if (old.writeSecret !== null && next.writeSecret === old.writeSecret) {
          throw new Error(`connection ${old.id}: re-seal the write secret or set it to NULL explicitly`)
        }
      }
      tables.databaseConnection[index] = next
      return { ...next }
    }),
  }
  const db = {
    $queryRaw: vi.fn(),
    databaseConnection,
    adminAction: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        tables.adminAction.push(data)
        return { id: `action-${tables.adminAction.length}`, ...data }
      }),
    },
    $transaction: vi.fn(async (run: (client: unknown) => Promise<unknown>): Promise<unknown> => {
      const saved = {
        databaseConnection: tables.databaseConnection.map((row) => ({ ...row })),
        adminAction: [...tables.adminAction],
      }
      try {
        return await run(db)
      } catch (error) {
        Object.assign(tables, saved)
        throw error
      }
    }),
  }
  return { db, tables }
})

vi.mock('@/shared/lib/db', () => ({ db }))

const requirePermission = vi.hoisted(() =>
  vi.fn(async (user: { permissions: string[] }, permission: string) => {
    if (!user.permissions.includes(permission)) {
      const { ForbiddenError } = await import('@/shared/lib/errors')
      throw new ForbiddenError(permission)
    }
  }),
)

vi.mock('@/shared/lib/auth-utils', () => ({
  getCurrentUser: vi.fn(async () => caller),
  requirePermission,
}))

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const runtime = vi.hoisted(() => ({ config: {} as Record<string, unknown> }))
vi.mock('@/shared/lib/runtime-config', () => ({ getRuntimeConfig: () => runtime.config }))

// A fixed ephemeral key makes a seal reproducible, so a test can compare an envelope byte for byte with the one sealed
// for the binding it expects. Without it every seal draws a fresh key, as in production.
const ephemeral = vi.hoisted(() => ({ privateKey: undefined as Buffer | undefined }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex')
  const generate = actual.generateKeyPairSync as (type: string, options?: unknown) => unknown
  const generateKeyPairSync = ((type: string, options?: unknown) => {
    if (type !== 'x25519' || ephemeral.privateKey === undefined) return generate(type, options)
    const privateKey = actual.createPrivateKey({
      key: Buffer.concat([pkcs8Prefix, ephemeral.privateKey]),
      format: 'der',
      type: 'pkcs8',
    })
    return { privateKey, publicKey: actual.createPublicKey(privateKey) }
  }) as typeof actual.generateKeyPairSync
  return { ...actual, default: { ...actual, generateKeyPairSync }, generateKeyPairSync }
})

// The license status of the install, which each test sets: null in cloud mode, where licensing does not apply.
const license = vi.hoisted(() => ({ status: null as LicenseStatus | null }))
vi.mock('@/shared/lib/license/install-license', () => ({ getLicenseStatus: () => license.status }))

import { updateDatabaseConnection } from './update-database-connection'
import { answerSeatStatement, locksTenant, statementText } from '../../../../tests/license/seat-statements'
import { SMALL_LICENSE_ACTIVE } from '../../../../tests/license/statuses'
import { LicenseLimitError } from '@/shared/lib/errors'
import { licenseStatus, type LicensePayload, type LicenseStatus } from '@/shared/lib/license'

// A published test key of Studio's lsb1 vectors, which protects nothing.
const VECTORS_FILE = path.resolve(__dirname, '../../../../tests/fixtures/governance/lsb1-vectors.json')
const CANARY = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors.find(
  (vector: { id: string }) => vector.id === 'canary',
) as { recipientPublicKey: string; kid: string; ephemeralPrivateKey: string }
const PUBLIC_KEY = Buffer.from(CANARY.recipientPublicKey, 'base64url')
const KID = CANARY.kid

const READ = { user: 'orders_reader', password: 'read-pass-1' }
const WRITE = { user: 'orders_writer', password: 'write-pass-1' }
const NEW_READ = { user: 'orders_reader', password: 'read-pass-2' }
const NEW_WRITE = { user: 'orders_writer', password: 'write-pass-2' }

const DEFINITION = { host: 'db.internal', port: 5432, database: 'orders' }
const MOVED = { host: 'replica.internal', port: 5432, database: 'orders' }

type UpdateInput = Parameters<typeof updateDatabaseConnection>[0]

function update(fields: Record<string, unknown>) {
  return updateDatabaseConnection(fields as UpdateInput)
}

function seal(id: string, level: 'read' | 'write', engine: string, definition: Row, plaintext: CredentialSet) {
  return sealSecret({ connectionId: id, level, engine, definition, plaintext }, PUBLIC_KEY)
}

function connection(id: string, overrides: Row = {}): Row {
  const engine = (overrides.engine as string | undefined) ?? 'postgres'
  const definition = (overrides.definition as Row | undefined) ?? DEFINITION
  return {
    id,
    tenantId: 'tenant-1',
    name: 'Orders',
    engine,
    environment: 'production',
    groupName: 'Sales',
    color: '#1E88E5',
    definition,
    readSecret: seal(id, 'read', engine, definition, READ),
    writeSecret: seal(id, 'write', engine, definition, WRITE),
    mcpEnabled: false,
    active: true,
    deletedAt: null,
    createdById: 'user-alice',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  }
}

function row(id: string): Row {
  const found = tables.databaseConnection.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

// A license issued 2026-10-16 that expires 2027-10-16, and the statuses of the install with it.
const LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-2026.0042',
  customer: 'Example Customer',
  adminSeats: 2,
  userSeats: 25,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
}
const ACTIVE_AT = new Date('2027-01-01T00:00:00Z')
const INVALID = licenseStatus({ ok: false, code: 'LICENSE_PAYLOAD_INVALID' }, ACTIVE_AT)
const FOUR_SEATS = licenseStatus({ ok: true, license: { ...LICENSE, userSeats: 4 } }, ACTIVE_AT)
const EXPIRED = licenseStatus({ ok: true, license: { ...LICENSE, userSeats: 100 } }, new Date('2027-11-01T00:00:00Z'))

/** A grant of a user on a connection, unexpired unless it has an expiry in the past. */
function storedGrant(connectionId: string, subject: string, expiresAt: Date | null = null): Row {
  return { id: `grant-${subject}-${connectionId}`, connectionId, subjectKind: 'user', subject, level: 'read', expiresAt }
}

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  runtime.config = { DEPLOYMENT_MODE: 'self-hosted', BRIDGE_SEAL_PUBLIC_KEY: CANARY.recipientPublicKey }
  caller.permissions = ['connection.view', 'connection.create', 'connection.edit', 'connection.delete']
  ephemeral.privateKey = undefined
  // A self-hosted install with an active license of 1 admin seat and 3 user seats.
  license.status = SMALL_LICENSE_ACTIVE
  tables.tenant = [{ id: 'tenant-1' }, { id: 'tenant-2' }]
  tables.databaseConnection = [
    connection('conn-orders'),
    connection('conn-reports', { name: 'Reports', writeSecret: null }),
    connection('conn-gone', { active: false, deletedAt: new Date('2026-10-02T00:00:00Z') }),
    connection('conn-foreign', { tenantId: 'tenant-2', name: 'Billing' }),
  ]
  tables.connectionGrant = []
  tables.adminAction = []
  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
    answerSeatStatement(tables, strings, values),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('updateDatabaseConnection', () => {
  it('a connection of another tenant answers NotFound', async () => {
    const before = tables.databaseConnection.map((candidate) => ({ ...candidate }))

    for (const id of ['conn-foreign', 'conn-gone', 'conn-unknown']) {
      const result = await update({ id, name: 'Taken over' })

      expect(result, id).toEqual({ success: false, error: 'Connection not found' })
    }
    expect(tables.databaseConnection).toEqual(before)
    expect(tables.adminAction).toEqual([])
  })

  it('a name, color, group, environment or MCP change keeps both envelopes', async () => {
    const { readSecret, writeSecret } = row('conn-orders')

    const result = await update({
      id: 'conn-orders',
      name: 'Orders EU',
      color: '#43A047',
      groupName: 'Finance',
      environment: 'staging',
      mcpEnabled: true,
      active: false,
    })

    expect(result).toEqual({ success: true, data: { id: 'conn-orders' } })
    expect(row('conn-orders')).toMatchObject({
      name: 'Orders EU',
      color: '#43A047',
      groupName: 'Finance',
      environment: 'staging',
      mcpEnabled: true,
      active: false,
      engine: 'postgres',
      definition: DEFINITION,
      readSecret,
      writeSecret,
    })
    const unchanged = { engine: 'postgres', definition: DEFINITION, readKid: KID, writeKid: KID }
    expect(tables.adminAction).toEqual([
      {
        actorId: 'user-alice',
        action: 'connection.update',
        targetType: 'connection',
        targetId: 'conn-orders',
        before: {
          name: 'Orders',
          environment: 'production',
          groupName: 'Sales',
          color: '#1E88E5',
          mcpEnabled: false,
          active: true,
          ...unchanged,
        },
        after: {
          name: 'Orders EU',
          environment: 'staging',
          groupName: 'Finance',
          color: '#43A047',
          mcpEnabled: true,
          active: false,
          ...unchanged,
        },
      },
    ])

    // Clearing the optional fields keeps the envelopes as well.
    const cleared = await update({ id: 'conn-orders', groupName: null, color: null, environment: null })
    expect(cleared.success).toBe(true)
    expect(row('conn-orders')).toMatchObject({ groupName: null, color: null, environment: null, readSecret, writeSecret })
  })

  it('a definition change without a new read credential is refused', async () => {
    const before = { ...row('conn-reports') }

    for (const change of [{ definition: MOVED }, { engine: 'mysql' }]) {
      const result = await update({ id: 'conn-reports', ...change })

      expect(result, JSON.stringify(change)).toEqual({
        success: false,
        error: 'Validation failed',
        fieldErrors: { readCredential: [expect.any(String)] },
      })
    }
    expect(row('conn-reports')).toEqual(before)
    expect(tables.adminAction).toEqual([])

    // The stored definition sent again, in another key order and with spaces the form left, is no change.
    const resent = await update({
      id: 'conn-reports',
      name: 'Reports replica',
      definition: { database: ' orders ', port: 5432, host: 'db.internal' },
    })
    expect(resent).toEqual({ success: true, data: { id: 'conn-reports' } })
    expect(row('conn-reports')).toMatchObject({ name: 'Reports replica', readSecret: before.readSecret })
  })

  it('a definition change on a connection with a write secret requires a new write credential or removeWriteCredential', async () => {
    const before = { ...row('conn-orders') }

    const withoutWrite = await update({
      id: 'conn-orders',
      definition: MOVED,
      readCredential: NEW_READ,
      readOnlyConfirmed: true,
    })

    expect(withoutWrite).toEqual({
      success: false,
      error: 'Validation failed',
      fieldErrors: { writeCredential: [expect.any(String)] },
    })
    expect(row('conn-orders')).toEqual(before)

    // Both credentials sealed again, for the new definition.
    ephemeral.privateKey = Buffer.from(CANARY.ephemeralPrivateKey, 'base64url')
    const resealed = await update({
      id: 'conn-orders',
      definition: MOVED,
      readCredential: NEW_READ,
      writeCredential: NEW_WRITE,
      readOnlyConfirmed: true,
    })

    expect(resealed).toEqual({ success: true, data: { id: 'conn-orders' } })
    const sealedFor = (level: 'read' | 'write', plaintext: CredentialSet) =>
      sealSecret({ connectionId: 'conn-orders', level, engine: 'postgres', definition: MOVED, plaintext }, PUBLIC_KEY, {
        ephemeralPrivateKey: ephemeral.privateKey,
      })
    expect(row('conn-orders')).toMatchObject({
      definition: MOVED,
      readSecret: sealedFor('read', NEW_READ),
      writeSecret: sealedFor('write', NEW_WRITE),
    })

    // Or the write credential removed while the read credential is sealed again.
    ephemeral.privateKey = undefined
    const moved = { ...MOVED, port: 6432 }
    const removed = await update({
      id: 'conn-orders',
      definition: moved,
      readCredential: NEW_READ,
      removeWriteCredential: true,
      readOnlyConfirmed: true,
    })

    expect(removed).toEqual({ success: true, data: { id: 'conn-orders' } })
    expect(row('conn-orders')).toMatchObject({ definition: moved, writeSecret: null })
    expect(tables.adminAction.map((action) => (action.after as Row).writeKid)).toEqual([KID, null])
    expect(JSON.stringify(tables.adminAction)).not.toContain('read-pass-2')
  })

  it('a credential alone is sealed again for the stored definition, and requires connection.edit', async () => {
    ephemeral.privateKey = Buffer.from(CANARY.ephemeralPrivateKey, 'base64url')
    const { writeSecret } = row('conn-orders')

    const rotated = await update({ id: 'conn-orders', readCredential: NEW_READ, readOnlyConfirmed: true })

    expect(rotated).toEqual({ success: true, data: { id: 'conn-orders' } })
    expect(row('conn-orders')).toMatchObject({
      definition: DEFINITION,
      readSecret: sealSecret(
        { connectionId: 'conn-orders', level: 'read', engine: 'postgres', definition: DEFINITION, plaintext: NEW_READ },
        PUBLIC_KEY,
        { ephemeralPrivateKey: ephemeral.privateKey },
      ),
      writeSecret,
    })
    expect(tables.adminAction[0].after).toMatchObject({ resealed: ['read'] })

    caller.permissions = ['connection.view']
    const denied = await update({ id: 'conn-orders', name: 'Mine' })
    expect(denied).toEqual({ success: false, error: 'Permission denied: connection.edit' })
  })

  it('cloud mode without BRIDGE_SEAL_PUBLIC_KEY refuses a credential change naming it and keeps metadata changes', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    runtime.config = { DEPLOYMENT_MODE: 'cloud' }
    const before = { ...row('conn-orders') }

    const rotated = await update({ id: 'conn-orders', readCredential: NEW_READ, readOnlyConfirmed: true })

    expect(rotated).toEqual({ success: false, error: expect.stringContaining('BRIDGE_SEAL_PUBLIC_KEY') })
    expect(row('conn-orders')).toEqual(before)

    const renamed = await update({ id: 'conn-orders', name: 'Orders EU' })
    expect(renamed).toEqual({ success: true, data: { id: 'conn-orders' } })
    expect(row('conn-orders')).toMatchObject({ name: 'Orders EU', readSecret: before.readSecret })
  })
})

describe('updateDatabaseConnection and the license of the install', () => {
  // conn-orders publishes alice and bob, and the paused conn-reports holds grants of bob, carol and dave and one of erin
  // that expired, so turning it active again makes alice, bob, carol and dave hold 4 user seats.
  function pauseReports() {
    row('conn-reports').active = false
    tables.connectionGrant = [
      storedGrant('conn-orders', 'alice'),
      storedGrant('conn-orders', 'bob'),
      storedGrant('conn-reports', 'bob'),
      storedGrant('conn-reports', 'carol'),
      storedGrant('conn-reports', 'dave'),
      storedGrant('conn-reports', 'erin', new Date(Date.now() - 60_000)),
    ]
  }

  it('refuses turning a connection active again when its grants would take more user seats than allowed, under an invalid license and after expiry, changing nothing', async () => {
    pauseReports()
    const before = tables.databaseConnection.map((candidate) => ({ ...candidate }))

    for (const [status, code] of [
      [SMALL_LICENSE_ACTIVE, 'LICENSE_USER_SEATS'],
      [INVALID, 'LICENSE_INVALID'],
      [EXPIRED, 'LICENSE_EXPIRED'],
    ] as const) {
      license.status = status
      expect(await update({ id: 'conn-reports', active: true, name: 'Reports again' }), code).toEqual({
        success: false,
        error: new LicenseLimitError(code).message,
      })
    }
    expect(tables.databaseConnection).toEqual(before)
    expect(tables.adminAction).toEqual([])

    // A license of 4 user seats allows the 4 seats the connection brings to 4 in use.
    license.status = FOUR_SEATS
    expect(await update({ id: 'conn-reports', active: true })).toEqual({ success: true, data: { id: 'conn-reports' } })
    expect(row('conn-reports').active).toBe(true)
  })

  it.each<[string, LicenseStatus]>([
    ['after expiry', EXPIRED],
    ['under an invalid license', INVALID],
  ])('renames, deactivates and seals again a connection %s, and takes no lock for it', async (_, status) => {
    pauseReports()
    license.status = status

    expect((await update({ id: 'conn-reports', name: 'Reports archive' })).success).toBe(true)
    expect((await update({ id: 'conn-orders', active: false })).success).toBe(true)
    expect((await update({ id: 'conn-orders', readCredential: NEW_READ, readOnlyConfirmed: true })).success).toBe(true)

    expect(row('conn-reports')).toMatchObject({ name: 'Reports archive', active: false })
    expect(row('conn-orders')).toMatchObject({ active: false })
    expect(tables.connectionGrant).toHaveLength(6)
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('locks the install tenant with the first statement of the transaction that turns a connection active again', async () => {
    pauseReports()
    license.status = FOUR_SEATS

    expect((await update({ id: 'conn-reports', active: true })).success).toBe(true)

    const [lock] = db.$queryRaw.mock.calls
    expect(locksTenant(statementText(lock[0]))).toBe(true)
    expect(lock.slice(1)).toEqual(['tenant-1'])
    // The action reads the connection before the transaction begins, and the transaction reads it again after the lock.
    const locked = db.$queryRaw.mock.invocationCallOrder[0]
    const [transactionBegan] = db.$transaction.mock.invocationCallOrder
    const [readBefore, readInside] = db.databaseConnection.findFirst.mock.invocationCallOrder
    expect(readBefore).toBeLessThan(transactionBegan)
    expect(transactionBegan).toBeLessThan(locked)
    expect(readInside).toBeGreaterThan(locked)
    expect(db.databaseConnection.update.mock.invocationCallOrder[0]).toBeGreaterThan(locked)
  })

  it('turns a connection active again in cloud mode, which has no license status, whatever the seats, and takes no lock', async () => {
    pauseReports()
    license.status = null

    expect((await update({ id: 'conn-reports', active: true })).success).toBe(true)

    expect(row('conn-reports').active).toBe(true)
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })
})
