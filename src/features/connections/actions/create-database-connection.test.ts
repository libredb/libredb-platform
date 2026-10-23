import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { sealSecret } from '@/shared/lib/sealing/lsb1'

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

// The plan of the caller's tenant, which the real checkLimit reads through db.tenant.
const plan = vi.hoisted(() => ({ maxConnections: 10 }))

// An in-memory stand-in for the tables the action touches. `tx` is the client inside the one $transaction, which
// restores the tables when its callback throws, as a rolled back transaction would; `db` is the client outside it.
// $queryRaw answers the statements of the seat gates over the same tables (tests/license/seat-statements.ts).
const { db, tx, tables } = vi.hoisted(() => {
  const tables: { tenant: Row[]; databaseConnection: Row[]; connectionGrant: Row[]; adminAction: Row[] } = {
    tenant: [],
    databaseConnection: [],
    connectionGrant: [],
    adminAction: [],
  }
  const matches = (row: Row, where: Where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const client = () => ({
    $queryRaw: vi.fn(),
    databaseConnection: {
      count: vi.fn(async ({ where }: { where: Where }) =>
        tables.databaseConnection.filter((row) => matches(row, where)).length),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = {
          environment: null,
          groupName: null,
          color: null,
          writeSecret: null,
          mcpEnabled: false,
          active: true,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }
        tables.databaseConnection.push(row)
        return { ...row }
      }),
    },
    adminAction: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        tables.adminAction.push(data)
        return { id: `action-${tables.adminAction.length}`, ...data }
      }),
    },
  })
  const tx = client()
  const db = {
    ...client(),
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        planConfig: { maxConnections: plan.maxConnections, maxUsers: 5, queryHistoryDays: 30 },
      })),
    },
    $transaction: vi.fn(async (run: (client: unknown) => Promise<unknown>): Promise<unknown> => {
      const saved = { databaseConnection: [...tables.databaseConnection], adminAction: [...tables.adminAction] }
      try {
        return await run(tx)
      } catch (error) {
        Object.assign(tables, saved)
        throw error
      }
    }),
  }
  return { db, tx, tables }
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

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/shared/lib/logger', () => ({ logger }))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

// The validated runtime configuration; a test without a seal key deletes BRIDGE_SEAL_PUBLIC_KEY from it.
const runtime = vi.hoisted(() => ({ config: {} as Record<string, unknown> }))
vi.mock('@/shared/lib/runtime-config', () => ({ getRuntimeConfig: () => runtime.config }))

// A fixed ephemeral key makes a seal reproducible, so a test can compare an envelope byte for byte with the one sealed
// for the binding it expects. Without it every seal draws a fresh key, as in production. Vitest resolves a named import
// of a Node built-in through its default export, so the mock replaces the function in both.
const ephemeral = vi.hoisted(() => ({ privateKey: undefined as Buffer | undefined }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  // The DER prefix that wraps a raw X25519 private key as PKCS #8 (RFC 8410).
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

import { createDatabaseConnection } from './create-database-connection'
import { answerSeatStatement, locksTenant, statementText } from '../../../../tests/license/seat-statements'
import { SMALL_LICENSE_ACTIVE } from '../../../../tests/license/statuses'
import { LicenseLimitError } from '@/shared/lib/errors'
import { licenseStatus, type LicensePayload, type LicenseStatus } from '@/shared/lib/license'

// A published test key of Studio's lsb1 vectors, which protects nothing, and its kid.
const VECTORS_FILE = path.resolve(__dirname, '../../../../tests/fixtures/governance/lsb1-vectors.json')
const CANARY = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors.find(
  (vector: { id: string }) => vector.id === 'canary',
) as { recipientPublicKey: string; kid: string; ephemeralPrivateKey: string }
const SEAL_PUBLIC_KEY = CANARY.recipientPublicKey
const KID = CANARY.kid

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const READ = { user: 'orders_reader', password: 'read-pass-1' }
const WRITE = { user: 'orders_writer', password: 'write-pass-1' }

// The definition as the form sends it, and as it is stored and sealed: the values trimmed.
const SUBMITTED_DEFINITION = { host: ' db.internal ', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } }
const DEFINITION = { host: 'db.internal', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } }

type CreateInput = Parameters<typeof createDatabaseConnection>[0]

function input(overrides: Record<string, unknown> = {}): CreateInput {
  return {
    name: 'Orders',
    engine: 'postgres',
    environment: 'production',
    groupName: 'Sales',
    color: '#1E88E5',
    definition: SUBMITTED_DEFINITION,
    readCredential: READ,
    readOnlyConfirmed: true,
    ...overrides,
  } as CreateInput
}

function storedRow(overrides: Row): Row {
  return {
    name: 'Existing',
    engine: 'postgres',
    environment: null,
    groupName: null,
    color: null,
    definition: { host: 'db.internal', database: 'existing' },
    readSecret: `lsb1.${KID}.${'A'.repeat(43)}.${'B'.repeat(30)}`,
    writeSecret: null,
    mcpEnabled: false,
    active: true,
    deletedAt: null,
    createdById: 'user-alice',
    ...overrides,
  }
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
const INVALID = licenseStatus({ ok: false, code: 'LICENSE_HOST_MISMATCH' }, ACTIVE_AT)
const TWO_SEATS = licenseStatus({ ok: true, license: { ...LICENSE, userSeats: 2 } }, ACTIVE_AT)
const EXPIRED = licenseStatus({ ok: true, license: { ...LICENSE, userSeats: 100 } }, new Date('2027-11-01T00:00:00Z'))

/** An unexpired read grant of a user on a connection. */
function storedGrant(connectionId: string, subject: string): Row {
  return { id: `grant-${subject}`, connectionId, subjectKind: 'user', subject, level: 'read', expiresAt: null }
}

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  runtime.config = { DEPLOYMENT_MODE: 'self-hosted', BRIDGE_SEAL_PUBLIC_KEY: SEAL_PUBLIC_KEY }
  caller.permissions = ['connection.view', 'connection.create', 'connection.edit', 'connection.delete']
  plan.maxConnections = 10
  // A self-hosted install with an active license of 1 admin seat and 3 user seats.
  license.status = SMALL_LICENSE_ACTIVE
  tables.tenant = [{ id: 'tenant-1' }]
  tables.databaseConnection = []
  tables.connectionGrant = []
  tables.adminAction = []
  tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
    answerSeatStatement(tables, strings, values),
  )
  ephemeral.privateKey = undefined
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('createDatabaseConnection', () => {
  it('returns only the id and never an envelope', async () => {
    const result = await createDatabaseConnection(input({ writeCredential: WRITE }))

    expect(tables.databaseConnection).toHaveLength(1)
    const [row] = tables.databaseConnection
    expect(row.id).toMatch(UUID)
    expect(result).toEqual({ success: true, data: { id: row.id } })
    expect(JSON.stringify(result)).not.toContain('lsb1.')
  })

  it('seals the read credential with an AAD bound to the generated id, the engine and the definition', async () => {
    ephemeral.privateKey = Buffer.from(CANARY.ephemeralPrivateKey, 'base64url')

    const result = await createDatabaseConnection(input({ writeCredential: WRITE }))

    expect(result.success).toBe(true)
    const [row] = tables.databaseConnection
    expect(row).toMatchObject({ tenantId: 'tenant-1', engine: 'postgres', definition: DEFINITION, createdById: 'user-alice' })
    // With the same ephemeral key, only an envelope sealed for this id, level, engine and definition has these bytes:
    // the AAD that binds them enters the AES-GCM tag.
    const sealedFor = (level: 'read' | 'write', plaintext: Record<string, string>) =>
      sealSecret(
        { connectionId: row.id as string, level, engine: 'postgres', definition: DEFINITION, plaintext },
        Buffer.from(SEAL_PUBLIC_KEY, 'base64url'),
        { ephemeralPrivateKey: ephemeral.privateKey },
      )
    expect(row.readSecret).toBe(sealedFor('read', READ))
    expect(row.writeSecret).toBe(sealedFor('write', WRITE))
  })

  it('requires the read-only confirmation and accepts a missing write credential', async () => {
    for (const confirmation of [{ readOnlyConfirmed: undefined }, { readOnlyConfirmed: false }]) {
      const result = await createDatabaseConnection(input(confirmation))

      expect(result, JSON.stringify(confirmation)).toEqual({
        success: false,
        error: 'Validation failed',
        fieldErrors: { readOnlyConfirmed: [expect.any(String)] },
      })
    }
    expect(tables.databaseConnection).toEqual([])

    const result = await createDatabaseConnection(input())

    expect(result.success).toBe(true)
    expect(tables.databaseConnection).toHaveLength(1)
    expect(tables.databaseConnection[0].readSecret).toMatch(new RegExp(`^lsb1\\.${KID}\\.`))
    expect(tables.databaseConnection[0].writeSecret).toBeNull()
  })

  it('records an admin action without secrets in the same transaction', async () => {
    const result = await createDatabaseConnection(input({ writeCredential: WRITE }))

    expect(result.success).toBe(true)
    const [row] = tables.databaseConnection
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.databaseConnection.create).toHaveBeenCalledTimes(1)
    expect(tx.adminAction.create).toHaveBeenCalledTimes(1)
    expect(db.databaseConnection.create).not.toHaveBeenCalled()
    expect(db.adminAction.create).not.toHaveBeenCalled()
    expect(tables.adminAction).toEqual([
      {
        actorId: 'user-alice',
        channel: 'web',
        action: 'connection.create',
        targetType: 'connection',
        targetId: row.id,
        before: Prisma.DbNull,
        after: {
          name: 'Orders',
          engine: 'postgres',
          environment: 'production',
          groupName: 'Sales',
          color: '#1E88E5',
          definition: DEFINITION,
          mcpEnabled: false,
          active: true,
          readKid: KID,
          writeKid: KID,
        },
      },
    ])
    const logged = JSON.stringify(tables.adminAction)
    for (const secret of [row.readSecret, row.writeSecret, READ.user, READ.password, WRITE.user, WRITE.password]) {
      expect(logged).not.toContain(secret)
    }

    // An admin action that cannot be written takes the connection with it.
    tx.adminAction.create.mockRejectedValueOnce(new Error('admin action refused'))
    const failed = await createDatabaseConnection(input({ name: 'Orders 2' }))

    expect(failed).toEqual({ success: false, error: 'Internal server error' })
    expect(tables.databaseConnection).toHaveLength(1)
  })

  it('the plan limit counts only connections that are not deleted', async () => {
    plan.maxConnections = 2
    tables.databaseConnection = [
      storedRow({ id: 'gone', tenantId: 'tenant-1', active: false, deletedAt: new Date('2026-10-01T00:00:00Z') }),
      storedRow({ id: 'paused', tenantId: 'tenant-1', active: false }),
      storedRow({ id: 'other-1', tenantId: 'tenant-2' }),
      storedRow({ id: 'other-2', tenantId: 'tenant-2' }),
    ]

    // The deleted connection frees its place; the inactive one keeps it.
    const second = await createDatabaseConnection(input())
    expect(second.success).toBe(true)

    const third = await createDatabaseConnection(input({ name: 'Orders 3' }))
    expect(third).toEqual({ success: false, error: expect.stringMatching(/^Limit exceeded: connections/) })
    expect(tables.databaseConnection.filter((row) => row.tenantId === 'tenant-1' && row.deletedAt === null)).toHaveLength(2)
  })

  it('a refusal names the limit of the plan, also when more connections exist than a lowered limit allows', async () => {
    plan.maxConnections = 2
    tables.databaseConnection = [storedRow({ id: 'first', tenantId: 'tenant-1' }), storedRow({ id: 'second', tenantId: 'tenant-1' })]

    expect(await createDatabaseConnection(input())).toEqual({ success: false, error: 'Limit exceeded: connections (max: 2)' })

    // The plan allowed three before an admin lowered its limit to two.
    tables.databaseConnection.push(storedRow({ id: 'third', tenantId: 'tenant-1' }))

    expect(await createDatabaseConnection(input())).toEqual({ success: false, error: 'Limit exceeded: connections (max: 2)' })
    expect(tables.databaseConnection).toHaveLength(3)
  })

  it('cloud mode without BRIDGE_SEAL_PUBLIC_KEY answers ConfigError naming it', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    runtime.config = { DEPLOYMENT_MODE: 'cloud' }

    const result = await createDatabaseConnection(input())

    expect(result).toEqual({ success: false, error: expect.stringContaining('BRIDGE_SEAL_PUBLIC_KEY') })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('CONFIG_ERROR'),
      expect.objectContaining({ code: 'CONFIG_ERROR' }),
    )
    expect(tables.databaseConnection).toEqual([])
    expect(tables.adminAction).toEqual([])
  })

  it('refuses a definition the engine does not admit and a caller without connection.create', async () => {
    const invalid = await createDatabaseConnection(input({ definition: { host: 'db.internal', password: 'p' } }))
    expect(invalid).toEqual({
      success: false,
      error: 'Validation failed',
      fieldErrors: { definition: [expect.any(String)], 'definition.database': [expect.any(String)] },
    })

    caller.permissions = ['connection.view']
    const denied = await createDatabaseConnection(input())
    expect(denied).toEqual({ success: false, error: 'Permission denied: connection.create' })
    expect(tables.databaseConnection).toEqual([])
  })
})

describe('createDatabaseConnection and the license of the install', () => {
  // bob, carol and dave take the three user seats of the license through a connection that exists.
  function takeEveryUserSeat() {
    tables.databaseConnection = [storedRow({ id: 'conn-existing', tenantId: 'tenant-1' })]
    tables.connectionGrant = ['bob', 'carol', 'dave'].map((subject) => storedGrant('conn-existing', subject))
  }

  it('creates a connection at the user-seat limit, and refuses one under an invalid license, above the limit and after expiry, writing nothing', async () => {
    takeEveryUserSeat()

    // A new connection takes no seat, so an install whose seats are all taken may still add one.
    expect((await createDatabaseConnection(input())).success).toBe(true)
    expect(tables.databaseConnection).toHaveLength(2)
    const recorded = tables.adminAction.length

    for (const [status, code] of [
      [INVALID, 'LICENSE_INVALID'],
      [TWO_SEATS, 'LICENSE_USER_SEATS'],
      [EXPIRED, 'LICENSE_EXPIRED'],
    ] as const) {
      license.status = status
      expect(await createDatabaseConnection(input({ name: 'Orders 2' })), code).toEqual({
        success: false,
        error: new LicenseLimitError(code).message,
      })
    }
    expect(tables.databaseConnection).toHaveLength(2)
    expect(tables.adminAction).toHaveLength(recorded)
  })

  it('locks the install tenant with the first statement of the transaction', async () => {
    expect((await createDatabaseConnection(input())).success).toBe(true)

    const [lock] = tx.$queryRaw.mock.calls
    expect(locksTenant(statementText(lock[0]))).toBe(true)
    expect(lock.slice(1)).toEqual(['tenant-1'])
    const locked = tx.$queryRaw.mock.invocationCallOrder[0]
    expect(tx.databaseConnection.create.mock.invocationCallOrder[0]).toBeGreaterThan(locked)
    expect(tx.adminAction.create.mock.invocationCallOrder[0]).toBeGreaterThan(locked)
  })

  it('creates a connection in cloud mode, which has no license status, whatever the seats in use, and takes no lock', async () => {
    takeEveryUserSeat()
    tables.connectionGrant.push(storedGrant('conn-existing', 'erin'))
    license.status = null

    expect((await createDatabaseConnection(input())).success).toBe(true)

    expect(tables.databaseConnection).toHaveLength(2)
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })
})
