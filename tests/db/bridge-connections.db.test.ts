import { randomBytes, randomUUID } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPlatform, connectStudio, connectSuperuser, connectUrl, FIXTURE_ROLES, urlFor } from './connect'
import { listenBridge } from './listen'
import { expectSqlState } from './sqlstate'

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'prisma', 'migrations')

// Every row of this file belongs to this tenant, plan and user, so the cleanup removes exactly them.
const MARKER = `bridge-connections-${randomUUID().slice(0, 8)}`
const TENANT_ID = `${MARKER}-tenant`
const PLAN_ID = `${MARKER}-plan`
const USER_ID = `${MARKER}-user`

// The definition keys that a CHECK refuses: the credential fields live only in the sealed envelopes.
const SECRET_DEFINITION_KEYS = [
  'user',
  'password',
  'connectionString',
  'privateKey',
  'privateKeyPassphrase',
  'apiKeyId',
  'apiKeySecret',
  'agentUser',
  'agentPassword',
  'sshTunnel',
]

interface Connection {
  id: string
  name: string
  engine: string
  environment: string | null
  groupName: string | null
  color: string | null
  definition: unknown
  readSecret: string
  writeSecret: string | null
  mcpEnabled: boolean
  active: boolean
  deletedAt: Date | null
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

// An lsb1 envelope for a random kid. The database checks only its format, never its content.
function envelope(kid: string = hex(8)): string {
  return `lsb1.${kid}.${randomBytes(32).toString('base64url')}.${randomBytes(40).toString('base64url')}`
}

// The legacy ivHex:tagHex:ctHex format of src/features/connections/lib/encryption.ts, which is no envelope.
function legacyCiphertext(): string {
  return `${hex(12)}:${hex(16)}:${hex(24)}`
}

// An active PostgreSQL connection with a read credential only, as Platform writes it.
function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: randomUUID(),
    name: 'Orders',
    engine: 'postgres',
    environment: 'production',
    groupName: 'Sales',
    color: '#1a2B3c',
    definition: { host: 'orders.db.internal', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } },
    readSecret: envelope(),
    writeSecret: null,
    mcpEnabled: false,
    active: true,
    deletedAt: null,
    ...overrides,
  }
}

async function insertConnection(client: Client, row: Connection): Promise<void> {
  await client.query(
    `INSERT INTO platform.database_connections
       (id, "tenantId", name, engine, environment, "groupName", color, definition, "readSecret", "writeSecret", "mcpEnabled", active, "deletedAt", "createdById")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      row.id,
      TENANT_ID,
      row.name,
      row.engine,
      row.environment,
      row.groupName,
      row.color,
      JSON.stringify(row.definition),
      row.readSecret,
      row.writeSecret,
      row.mcpEnabled,
      row.active,
      row.deletedAt,
      USER_ID,
    ],
  )
}

async function readConnection(client: Client, id: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    `SELECT id, name, engine, environment, "groupName", color, definition, "readSecret", "writeSecret", "mcpEnabled", active,
            "deletedAt", "updatedAt"
       FROM platform.database_connections
      WHERE id = $1`,
    [id],
  )
  expect(result.rows).toHaveLength(1)
  return result.rows[0]
}

// The row of bridge.connections_v1 for a connection, in the column order of the snapshot query.
function viewRow(row: Connection): Record<string, unknown> {
  return {
    connection_id: row.id,
    name: row.name,
    engine: row.engine,
    environment: row.environment,
    group_name: row.groupName,
    color: row.color,
    definition: row.definition,
    read_secret: row.readSecret,
    write_secret: row.writeSecret,
    mcp_enabled: row.mcpEnabled,
    updated_at: expect.any(Date),
  }
}

const SNAPSHOT_COLUMNS =
  'connection_id, name, engine, environment, group_name, color, definition, read_secret, write_secret, mcp_enabled, updated_at'

// Asserts that the operation fails with SQLSTATE 23514 raised by the named CHECK constraint.
async function expectCheckViolation(operation: Promise<unknown>, constraint: string): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error, `expected the CHECK constraint ${constraint} to refuse the row`).toMatchObject({ code: CHECK_VIOLATION, constraint })
}

// Asserts that the operation fails with SQLSTATE 23514 raised by the rebind trigger, whose message names the rule.
async function expectRebindRefusal(operation: Promise<unknown>, message: RegExp): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error, 'expected the rebind trigger to refuse the update').toMatchObject({
    code: CHECK_VIOLATION,
    message: expect.stringMatching(message),
  })
}

// The privileges of an ACL other than the owner's own, as grantee:privilege, sorted.
const GRANTS_OF = (acl: string, owner: string) => `
  coalesce((SELECT array_agg(entry ORDER BY entry COLLATE "C")
              FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type AS entry
                      FROM aclexplode(${acl}) a
                     WHERE a.grantee <> ${owner}) entries), '{}')`

// Applied by tests/db/global-setup.ts, which runs `prisma migrate deploy` as libredb_owner.
describe('platform.database_connections, its database rules and bridge.connections_v1', () => {
  let superuser: Client
  let platform: Client
  let studio: Client

  beforeAll(async () => {
    superuser = await connectSuperuser()
    platform = await connectPlatform()
    studio = await connectStudio()

    await platform.query(`INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, $1, 'Probe', now())`, [PLAN_ID])
    await platform.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'Probe', $1, $2, now())`,
      [TENANT_ID, PLAN_ID],
    )
    await platform.query(`INSERT INTO platform.users (id, email, "updatedAt") VALUES ($1, $2, now())`, [
      USER_ID,
      `${USER_ID}@libredb.test`,
    ])
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.database_connections WHERE "tenantId" = $1', [TENANT_ID])
    await superuser.query('DELETE FROM platform.tenants WHERE id = $1', [TENANT_ID])
    await superuser.query('DELETE FROM platform.plan_configs WHERE id = $1', [PLAN_ID])
    await superuser.query('DELETE FROM platform.users WHERE id = $1', [USER_ID])
    await studio.end()
    await platform.end()
    await superuser.end()
  })

  it("bridge.connections_v1 shows active, non-deleted connections with snake_case columns of the contract's types", async () => {
    const shown = connection({ writeSecret: envelope(), mcpEnabled: true })
    const bare = connection({ name: 'Ledger', environment: null, groupName: null, color: null })
    const inactive = connection({ active: false })
    const deleted = connection({ deletedAt: new Date() })
    for (const row of [shown, bare, inactive, deleted]) {
      await insertConnection(platform, row)
    }

    const expected = [shown, bare].sort((a, b) => (a.id < b.id ? -1 : 1)).map(viewRow)
    for (const client of [studio, platform]) {
      const view = await client.query(
        `SELECT ${SNAPSHOT_COLUMNS} FROM "bridge".connections_v1 WHERE connection_id = ANY($1) ORDER BY connection_id COLLATE "C"`,
        [[shown.id, bare.id, inactive.id, deleted.id]],
      )
      expect(view.rows).toEqual(expected)
    }

    // The column names and types of the contract manifest, where timestamptz is PostgreSQL's timestamp with time zone.
    const columns = await superuser.query<{ name: string; type: string }>(
      `SELECT attname AS name, format_type(atttypid, NULL) AS type
         FROM pg_attribute
        WHERE attrelid = 'bridge.connections_v1'::regclass AND attnum > 0 AND NOT attisdropped
        ORDER BY attnum`,
    )
    expect(columns.rows).toEqual([
      { name: 'connection_id', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'engine', type: 'text' },
      { name: 'environment', type: 'text' },
      { name: 'group_name', type: 'text' },
      { name: 'color', type: 'text' },
      { name: 'definition', type: 'jsonb' },
      { name: 'read_secret', type: 'text' },
      { name: 'write_secret', type: 'text' },
      { name: 'mcp_enabled', type: 'boolean' },
      { name: 'updated_at', type: 'timestamp with time zone' },
    ])

    // The nullability of the manifest comes from the source columns, because a view column is never NOT NULL.
    const sources = await superuser.query<{ name: string; not_null: boolean }>(
      `SELECT attname AS name, attnotnull AS not_null
         FROM pg_attribute
        WHERE attrelid = 'platform.database_connections'::regclass
          AND attname IN ('id', 'name', 'engine', 'environment', 'groupName', 'color', 'definition', 'readSecret', 'writeSecret',
                          'mcpEnabled', 'updatedAt')`,
    )
    expect(Object.fromEntries(sources.rows.map((row) => [row.name, row.not_null]))).toEqual({
      id: true,
      name: true,
      engine: true,
      environment: false,
      groupName: false,
      color: false,
      definition: true,
      readSecret: true,
      writeSecret: false,
      mcpEnabled: true,
      updatedAt: true,
    })
  })

  it('a definition with a password key, an sshTunnel key or an ssl.clientKey is refused (23514)', async () => {
    for (const key of SECRET_DEFINITION_KEYS) {
      const value = key === 'sshTunnel' ? { host: 'bastion.internal', port: 22 } : 'secret'
      await expectCheckViolation(
        insertConnection(platform, connection({ definition: { host: 'orders.db.internal', database: 'orders', [key]: value } })),
        'database_connections_definition_no_secrets',
      )
    }
    await expectCheckViolation(
      insertConnection(
        platform,
        connection({ definition: { host: 'orders.db.internal', ssl: { mode: 'verify-full', clientKey: '-----BEGIN PRIVATE KEY-----' } } }),
      ),
      'database_connections_definition_no_secrets',
    )

    // An update cannot add a secret either, even with a newly sealed read secret.
    const row = connection()
    await insertConnection(platform, row)
    await expectCheckViolation(
      platform.query(
        `UPDATE platform.database_connections SET definition = definition || '{"password": "secret"}', "readSecret" = $2 WHERE id = $1`,
        [row.id, envelope()],
      ),
      'database_connections_definition_no_secrets',
    )

    // The client certificate and the CA are not secrets.
    await insertConnection(
      platform,
      connection({
        definition: {
          host: 'orders.db.internal',
          ssl: { mode: 'verify-full', ca: '-----BEGIN CERTIFICATE-----', clientCert: '-----BEGIN CERTIFICATE-----' },
        },
      }),
    )
  })

  it('an id outside ^[a-z0-9-]{1,64}$ and an envelope without the lsb prefix are refused (23514)', async () => {
    for (const id of ['', 'Orders', 'orders_db', 'seed:orders', 'a'.repeat(65)]) {
      await expectCheckViolation(insertConnection(platform, connection({ id })), 'database_connections_id_format')
    }
    await insertConnection(platform, connection({ id: `${hex(4)}-${'a'.repeat(55)}` }))

    for (const readSecret of [legacyCiphertext(), envelope().replace(/^lsb1\./, 'lsb0.'), envelope('0123456789ABCDEF')]) {
      await expectCheckViolation(insertConnection(platform, connection({ readSecret })), 'database_connections_readSecret_format')
    }
    await expectCheckViolation(
      insertConnection(platform, connection({ writeSecret: legacyCiphertext() })),
      'database_connections_writeSecret_format',
    )

    // A later envelope format such as lsb2 passes the format check.
    await insertConnection(platform, connection({ readSecret: envelope().replace(/^lsb1\./, 'lsb2.') }))
  })

  it('a name, engine, environment, group, color or definition outside the rules of the contract is refused (23514)', async () => {
    const refused: Array<[Partial<Connection>, string]> = [
      [{ name: '' }, 'database_connections_name_check'],
      [{ name: 'n'.repeat(129) }, 'database_connections_name_check'],
      [{ engine: 'Postgres' }, 'database_connections_engine_check'],
      [{ engine: 'sql-server' }, 'database_connections_engine_check'],
      [{ engine: 'e'.repeat(33) }, 'database_connections_engine_check'],
      [{ environment: 'PRODUCTION' }, 'database_connections_environment_check'],
      [{ groupName: '' }, 'database_connections_groupName_check'],
      [{ groupName: 'g'.repeat(65) }, 'database_connections_groupName_check'],
      [{ color: 'red' }, 'database_connections_color_check'],
      [{ color: '#12345' }, 'database_connections_color_check'],
      [{ definition: [] }, 'database_connections_definition_check'],
      [{ definition: 42 }, 'database_connections_definition_check'],
    ]
    for (const [overrides, constraint] of refused) {
      await expectCheckViolation(insertConnection(platform, connection(overrides)), constraint)
    }

    for (const environment of ['production', 'staging', 'development', 'local', 'other']) {
      await insertConnection(platform, connection({ environment, name: 'n'.repeat(128), groupName: 'g'.repeat(64) }))
    }
  })

  it('a definition change that keeps the old read secret is refused by the rebind trigger', async () => {
    const row = connection()
    await insertConnection(platform, row)

    const readRule = /newly sealed read secret/
    await expectRebindRefusal(
      platform.query(
        `UPDATE platform.database_connections SET definition = jsonb_set(definition, '{host}', '"replica.db.internal"') WHERE id = $1`,
        [row.id],
      ),
      readRule,
    )
    // A TLS downgrade is a definition change too.
    await expectRebindRefusal(
      platform.query(
        `UPDATE platform.database_connections SET definition = jsonb_set(definition, '{ssl,mode}', '"disable"') WHERE id = $1`,
        [row.id],
      ),
      readRule,
    )
    await expectRebindRefusal(platform.query(`UPDATE platform.database_connections SET engine = 'mysql' WHERE id = $1`, [row.id]), readRule)
    await expectRebindRefusal(
      platform.query('UPDATE platform.database_connections SET id = $2 WHERE id = $1', [row.id, randomUUID()]),
      readRule,
    )
    expect(await readConnection(platform, row.id)).toMatchObject({ definition: row.definition, engine: 'postgres', readSecret: row.readSecret })

    // The same change passes with a newly sealed read secret.
    const resealed = envelope()
    await platform.query(
      `UPDATE platform.database_connections SET definition = jsonb_set(definition, '{host}', '"replica.db.internal"'), "readSecret" = $2 WHERE id = $1`,
      [row.id, resealed],
    )
    expect(await readConnection(platform, row.id)).toMatchObject({
      definition: { host: 'replica.db.internal', port: 5432, database: 'orders', ssl: { mode: 'verify-full' } },
      readSecret: resealed,
      writeSecret: null,
    })
  })

  it('a definition change on a row with a write secret must re-seal it or set it to NULL', async () => {
    const row = connection({ writeSecret: envelope() })
    await insertConnection(platform, row)

    const writeRule = /re-seal the write secret or set it to NULL/
    await expectRebindRefusal(
      platform.query(
        `UPDATE platform.database_connections SET definition = jsonb_set(definition, '{database}', '"orders_archive"'), "readSecret" = $2 WHERE id = $1`,
        [row.id, envelope()],
      ),
      writeRule,
    )
    await expectRebindRefusal(
      platform.query(`UPDATE platform.database_connections SET engine = 'mysql', "readSecret" = $2 WHERE id = $1`, [row.id, envelope()]),
      writeRule,
    )
    expect(await readConnection(platform, row.id)).toMatchObject({ readSecret: row.readSecret, writeSecret: row.writeSecret })

    const read = envelope()
    const write = envelope()
    await platform.query(
      `UPDATE platform.database_connections SET definition = jsonb_set(definition, '{database}', '"orders_archive"'), "readSecret" = $2, "writeSecret" = $3 WHERE id = $1`,
      [row.id, read, write],
    )
    expect(await readConnection(platform, row.id)).toMatchObject({ readSecret: read, writeSecret: write })

    const readOnly = envelope()
    await platform.query(
      `UPDATE platform.database_connections SET definition = jsonb_set(definition, '{database}', '"orders"'), "readSecret" = $2, "writeSecret" = NULL WHERE id = $1`,
      [row.id, readOnly],
    )
    expect(await readConnection(platform, row.id)).toMatchObject({ readSecret: readOnly, writeSecret: null })
  })

  it('a metadata change keeps the envelopes', async () => {
    const row = connection({ writeSecret: envelope() })
    await insertConnection(platform, row)
    const before = await readConnection(platform, row.id)

    await new Promise((resolve) => setTimeout(resolve, 20))
    await platform.query(
      `UPDATE platform.database_connections
          SET name = 'Orders replica', color = '#00FF00', "groupName" = 'Finance', environment = 'staging', "mcpEnabled" = true, active = false
        WHERE id = $1`,
      [row.id],
    )
    const after = await readConnection(platform, row.id)
    expect(after).toMatchObject({
      name: 'Orders replica',
      color: '#00FF00',
      groupName: 'Finance',
      environment: 'staging',
      mcpEnabled: true,
      active: false,
      definition: row.definition,
      readSecret: row.readSecret,
      writeSecret: row.writeSecret,
    })
    // The trigger stamps every update with the database clock.
    expect((after.updatedAt as Date).getTime()).toBeGreaterThan((before.updatedAt as Date).getTime())

    // A soft delete is a metadata change as well.
    await platform.query(`UPDATE platform.database_connections SET "deletedAt" = now() WHERE id = $1`, [row.id])
    expect(await readConnection(platform, row.id)).toMatchObject({
      deletedAt: expect.any(Date),
      readSecret: row.readSecret,
      writeSecret: row.writeSecret,
    })
  })

  it('libredb_platform cannot drop the rebind trigger', async () => {
    const statements = [
      'DROP TRIGGER database_connections_rebind ON platform.database_connections',
      'ALTER TABLE platform.database_connections DISABLE TRIGGER database_connections_rebind',
      'ALTER TABLE platform.database_connections DISABLE TRIGGER ALL',
      'DROP FUNCTION platform.database_connections_rebind()',
      'ALTER FUNCTION platform.database_connections_rebind() OWNER TO libredb_platform',
      `CREATE OR REPLACE FUNCTION platform.database_connections_rebind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      // Replica mode would skip every ordinary trigger for the session.
      `SET session_replication_role = 'replica'`,
    ]
    for (const statement of statements) {
      await expectSqlState(platform.query(statement), INSUFFICIENT_PRIVILEGE)
    }

    const trigger = await superuser.query(
      `SELECT pg_get_triggerdef(t.oid) AS definition, t.tgenabled AS enabled, pg_get_userbyid(p.proowner) AS function_owner
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'platform.database_connections'::regclass AND t.tgname = 'database_connections_rebind'`,
    )
    expect(trigger.rows).toEqual([
      {
        definition:
          'CREATE TRIGGER database_connections_rebind BEFORE UPDATE ON platform.database_connections FOR EACH ROW EXECUTE FUNCTION platform.database_connections_rebind()',
        enabled: 'O',
        function_owner: 'libredb_owner',
      },
    ])

    // The trigger still refuses a rebind after the attempts.
    const row = connection()
    await insertConnection(platform, row)
    await expectRebindRefusal(
      platform.query(`UPDATE platform.database_connections SET engine = 'mysql' WHERE id = $1`, [row.id]),
      /newly sealed read secret/,
    )
  })

  it('one notification of kind connections arrives per committed statement', async () => {
    const listener = await listenBridge()
    const writer = await connectPlatform()
    const notification = { v: 1, kind: 'connections' }
    try {
      const first = connection()
      const second = connection()
      await writer.query(
        `INSERT INTO platform.database_connections (id, "tenantId", name, engine, definition, "readSecret", "createdById")
         VALUES ($1, $3, 'First', 'postgres', '{"host": "first.db.internal", "database": "first"}', $4, $5),
                ($2, $3, 'Second', 'postgres', '{"host": "second.db.internal", "database": "second"}', $6, $5)`,
        [first.id, second.id, TENANT_ID, envelope(), USER_ID, envelope()],
      )
      expect(await listener.flush()).toEqual([notification])

      await writer.query(`UPDATE platform.database_connections SET color = '#123456' WHERE id = ANY($1)`, [[first.id, second.id]])
      expect(await listener.flush()).toEqual([notification])

      // Nothing arrives before the commit and nothing after a rollback.
      await writer.query('BEGIN')
      await writer.query(`UPDATE platform.database_connections SET "mcpEnabled" = true WHERE id = $1`, [first.id])
      expect(await listener.flush()).toEqual([])
      await writer.query('COMMIT')
      expect(await listener.flush()).toEqual([notification])

      await writer.query('BEGIN')
      await writer.query(`UPDATE platform.database_connections SET active = false WHERE id = $1`, [second.id])
      await writer.query('ROLLBACK')
      expect(await listener.flush()).toEqual([])

      // The delete cascades to platform.connection_grants, whose statement-level trigger sends kind grants as well,
      // even when the connections have no grant.
      await writer.query('DELETE FROM platform.database_connections WHERE id = ANY($1)', [[first.id, second.id]])
      const payloads = (await listener.flush()) as Array<{ kind: string }>
      expect([...payloads].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([notification, { v: 1, kind: 'grants' }])
    } finally {
      await writer.end()
      await listener.close()
    }

    const triggers = await superuser.query<{ definition: string }>(
      `SELECT pg_get_triggerdef(oid) AS definition
         FROM pg_trigger
        WHERE tgrelid = 'platform.database_connections'::regclass AND tgname = 'bridge_notify'`,
    )
    expect(triggers.rows).toEqual([
      {
        definition:
          "CREATE TRIGGER bridge_notify AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON platform.database_connections FOR EACH STATEMENT EXECUTE FUNCTION bridge.notify_change('connections')",
      },
    ])
  })

  it('libredb_studio can read bridge.connections_v1 and not platform.database_connections (42501)', async () => {
    const row = connection()
    await insertConnection(platform, row)

    const view = await studio.query(`SELECT ${SNAPSHOT_COLUMNS} FROM "bridge".connections_v1 WHERE connection_id = $1`, [row.id])
    expect(view.rows).toEqual([viewRow(row)])

    await expectSqlState(studio.query('SELECT id FROM platform.database_connections LIMIT 1'), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(
      studio.query(`UPDATE "bridge".connections_v1 SET name = 'Renamed' WHERE connection_id = $1`, [row.id]),
      INSUFFICIENT_PRIVILEGE,
    )
    await expectSqlState(studio.query(`DELETE FROM "bridge".connections_v1 WHERE connection_id = $1`, [row.id]), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(
      studio.query(
        `INSERT INTO "bridge".connections_v1 (connection_id, name, engine, definition, read_secret) VALUES ($1, 'Injected', 'postgres', '{}', $2)`,
        [randomUUID(), envelope()],
      ),
      INSUFFICIENT_PRIVILEGE,
    )
  })

  it('bridge.connections_v1 belongs to libredb_owner with the view options of the contract and SELECT for both runtime roles only', async () => {
    const view = await superuser.query<{ owner: string; options: string[]; grants: string[] }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner, c.reloptions AS options,
              ${GRANTS_OF("coalesce(c.relacl, acldefault('r', c.relowner))", 'c.relowner')} AS grants
         FROM pg_class c
        WHERE c.oid = 'bridge.connections_v1'::regclass`,
    )
    expect(view.rows.map((row) => ({ ...row, options: [...row.options].sort() }))).toEqual([
      {
        owner: 'libredb_owner',
        options: ['security_barrier=true', 'security_invoker=false'],
        grants: ['libredb_platform:SELECT', 'libredb_studio:SELECT'],
      },
    ])

    const table = await superuser.query<{ owner: string; grants: string[] }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner,
              ${GRANTS_OF("coalesce(c.relacl, acldefault('r', c.relowner))", 'c.relowner')} AS grants
         FROM pg_class c
        WHERE c.oid = 'platform.database_connections'::regclass`,
    )
    expect(table.rows).toEqual([
      {
        owner: 'libredb_owner',
        grants: ['libredb_platform:DELETE', 'libredb_platform:INSERT', 'libredb_platform:SELECT', 'libredb_platform:UPDATE'],
      },
    ])
  })

  it('the connections_v2 migration keeps the rows of the existing table as platform.legacy_database_connections', async () => {
    const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const target = migrations.findIndex((name) => name.endsWith('_connections_v2'))
    expect(target, 'a migration <timestamp>_connections_v2 after the baseline').toBeGreaterThan(0)
    const sqlOf = (name: string) => readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8')

    // A scratch database that holds legacy rows when the migration runs, which the fixture database never does.
    const database = `connections_v2_${hex(6)}`
    await superuser.query(`CREATE DATABASE ${database} OWNER libredb_owner`)
    const owner = await connectUrl(urlFor(FIXTURE_ROLES.owner.user, FIXTURE_ROLES.owner.password, database))
    try {
      for (const name of migrations.slice(0, target)) {
        await owner.query(sqlOf(name))
      }
      await owner.query(`INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ('plan-1', 'probe', 'Probe', now())`)
      await owner.query(`INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ('tenant-1', 'Probe', 'probe', 'plan-1', now())`)
      await owner.query(`INSERT INTO platform.users (id, email, "updatedAt") VALUES ('user-1', 'user-1@libredb.test', now())`)
      await owner.query(
        `INSERT INTO platform.database_connections (id, "tenantId", name, type, host, port, database, username, "passwordEncrypted", "sslEnabled", "sshTunnelConfig", "updatedAt")
         VALUES ('legacy-1', 'tenant-1', 'Orders', 'POSTGRESQL', 'orders.db.internal', 5432, 'orders', 'reader', $1, true, NULL, now()),
                ('legacy-2', 'tenant-1', 'Cache', 'REDIS', 'cache.internal', 6379, '0', 'default', $2, false, '{"host": "bastion"}', now())`,
        [legacyCiphertext(), legacyCiphertext()],
      )
      await owner.query(`INSERT INTO platform.connection_permissions (id, "connectionId", "canRead") VALUES ('permission-1', 'legacy-1', true)`)
      await owner.query(
        `INSERT INTO platform.query_audit_logs (id, "tenantId", "userId", "connectionId", query, "queryType", status)
         VALUES ('audit-1', 'tenant-1', 'user-1', 'legacy-2', 'GET key', 'OTHER', 'success')`,
      )
      const before = await owner.query('SELECT * FROM platform.database_connections ORDER BY id')
      expect(before.rows).toHaveLength(2)

      await owner.query(sqlOf(migrations[target]))

      const after = await owner.query('SELECT * FROM platform.legacy_database_connections ORDER BY id')
      expect(after.rows).toEqual(before.rows)
      const references = await owner.query(
        `SELECT p.id, c.name FROM platform.connection_permissions p JOIN platform.legacy_database_connections c ON c.id = p."connectionId"
         UNION ALL
         SELECT a.id, c.name FROM platform.query_audit_logs a JOIN platform.legacy_database_connections c ON c.id = a."connectionId"
         ORDER BY 1`,
      )
      expect(references.rows).toEqual([
        { id: 'audit-1', name: 'Cache' },
        { id: 'permission-1', name: 'Orders' },
      ])
      const fresh = await owner.query('SELECT count(*)::int AS count FROM platform.database_connections')
      expect(fresh.rows).toEqual([{ count: 0 }])
    } finally {
      await owner.end()
      await superuser.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    }
  })

  it('the drop_legacy_connections migration drops the legacy rows and takes connection.view and the Connections menu from TENANT_EDITOR and TENANT_VIEWER only', async () => {
    const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const target = migrations.findIndex((name) => name.endsWith('_drop_legacy_connections'))
    expect(target, 'a migration <timestamp>_drop_legacy_connections after connections_v2').toBeGreaterThan(
      migrations.findIndex((name) => name.endsWith('_connections_v2')),
    )
    const sqlOf = (name: string) => readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8')

    // A scratch database whose legacy tables hold rows and whose roles carry the permissions and menus of the older seed.
    const database = `drop_legacy_${hex(6)}`
    await superuser.query(`CREATE DATABASE ${database} OWNER libredb_owner`)
    const owner = await connectUrl(urlFor(FIXTURE_ROLES.owner.user, FIXTURE_ROLES.owner.password, database))
    try {
      for (const name of migrations.slice(0, target)) {
        await owner.query(sqlOf(name))
      }
      await owner.query(`INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ('plan-1', 'probe', 'Probe', now())`)
      await owner.query(`INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ('tenant-1', 'Probe', 'probe', 'plan-1', now())`)
      await owner.query(
        `INSERT INTO platform.legacy_database_connections (id, "tenantId", name, type, host, port, database, username, "passwordEncrypted", "updatedAt")
         VALUES ('legacy-1', 'tenant-1', 'Orders', 'POSTGRESQL', 'orders.db.internal', 5432, 'orders', 'reader', $1, now())`,
        [legacyCiphertext()],
      )
      await owner.query(`INSERT INTO platform.connection_permissions (id, "connectionId", "canRead") VALUES ('permission-1', 'legacy-1', true)`)
      await owner.query(
        `INSERT INTO platform.roles (id, code, name, "isSystem", "tenantId", "updatedAt")
         VALUES ('role-admin', 'TENANT_ADMIN', 'TENANT_ADMIN', true, NULL, now()),
                ('role-editor', 'TENANT_EDITOR', 'TENANT_EDITOR', true, NULL, now()),
                ('role-viewer', 'TENANT_VIEWER', 'TENANT_VIEWER', true, NULL, now()),
                ('role-custom', 'DATA_ANALYST', 'Data analyst', false, 'tenant-1', now())`,
      )
      await owner.query(
        `INSERT INTO platform.permissions (id, code, name, category)
         VALUES ('perm-view', 'connection.view', 'connection.view', 'connection'),
                ('perm-ticket', 'ticket.view', 'ticket.view', 'ticket')`,
      )
      await owner.query(
        `INSERT INTO platform.role_permissions ("roleId", "permissionId")
         SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p`,
      )
      await owner.query(
        `INSERT INTO platform.menus (id, code, name, url)
         VALUES ('menu-connections', 'CONNECTIONS', 'Connections', '/connections'),
                ('menu-support', 'SUPPORT', 'Support', '/support')`,
      )
      await owner.query(
        `INSERT INTO platform.menu_roles ("menuId", "roleId")
         SELECT m.id, r.id FROM platform.menus m CROSS JOIN platform.roles r`,
      )

      await owner.query(sqlOf(migrations[target]))

      const legacy = await owner.query(
        `SELECT to_regclass('platform.legacy_database_connections') IS NULL AS legacy_dropped,
                to_regclass('platform.connection_permissions') IS NULL AS permissions_dropped`,
      )
      expect(legacy.rows).toEqual([{ legacy_dropped: true, permissions_dropped: true }])
      const permissions = await owner.query(
        `SELECT r.code AS role, p.code AS permission
           FROM platform.role_permissions rp
           JOIN platform.roles r ON r.id = rp."roleId"
           JOIN platform.permissions p ON p.id = rp."permissionId"
          ORDER BY r.code COLLATE "C", p.code COLLATE "C"`,
      )
      expect(permissions.rows).toEqual([
        { role: 'DATA_ANALYST', permission: 'connection.view' },
        { role: 'DATA_ANALYST', permission: 'ticket.view' },
        { role: 'TENANT_ADMIN', permission: 'connection.view' },
        { role: 'TENANT_ADMIN', permission: 'ticket.view' },
        { role: 'TENANT_EDITOR', permission: 'ticket.view' },
        { role: 'TENANT_VIEWER', permission: 'ticket.view' },
      ])
      const menus = await owner.query(
        `SELECT r.code AS role, m.code AS menu
           FROM platform.menu_roles mr
           JOIN platform.roles r ON r.id = mr."roleId"
           JOIN platform.menus m ON m.id = mr."menuId"
          ORDER BY r.code COLLATE "C", m.code COLLATE "C"`,
      )
      expect(menus.rows).toEqual([
        { role: 'DATA_ANALYST', menu: 'CONNECTIONS' },
        { role: 'DATA_ANALYST', menu: 'SUPPORT' },
        { role: 'TENANT_ADMIN', menu: 'CONNECTIONS' },
        { role: 'TENANT_ADMIN', menu: 'SUPPORT' },
        { role: 'TENANT_EDITOR', menu: 'SUPPORT' },
        { role: 'TENANT_VIEWER', menu: 'SUPPORT' },
      ])
    } finally {
      await owner.end()
      await superuser.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    }
  })
})
