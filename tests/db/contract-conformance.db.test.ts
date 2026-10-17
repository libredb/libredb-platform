import { randomBytes, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import path from 'path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectOwner, connectPlatform, connectStudio, connectSuperuser } from './connect'
import { createFreshDatabase } from './fresh-database'
import { BRIDGE_CHANNEL, listenBridge, type BridgeListener } from './listen'
import { expectSqlState } from './sqlstate'

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'

const DAY_MS = 24 * 60 * 60 * 1000

// The manifest of the pinned Studio build, vendored by scripts/vendor-studio-governance.mjs with the build recorded in
// STUDIO_TAG. Every expectation of this file comes from it.
const MANIFEST_FILE = path.join(__dirname, '..', 'fixtures', 'governance', 'contract-v1.json')

// A database of its own, created and migrated as a fresh install is, so no other test file's rows reach it.
const DATABASE = 'libredb_conformance'

// The rows behind the read views belong to this plan, tenant and user.
const PLAN_ID = 'conformance-plan'
const TENANT_ID = 'conformance-tenant'
const USER_ID = 'conformance-user'

// A value outside every closed vocabulary of the manifest.
const OUTSIDE = 'outside-the-vocabulary'

type Grants = Record<string, string[]>

interface ManifestColumn {
  name: string
  type: string
  nullable: boolean
  check: { kind: string; values?: string[]; sql: string } | null
}

interface ManifestView {
  kind: 'view'
  name: string
  over: string | null
  checkOption: string | null
  notifyKind: string | null
  columns: ManifestColumn[]
  grants: Grants
}

interface ManifestTable {
  kind: 'table'
  name: string
  columns: ManifestColumn[]
  primaryKey: string[]
  constraints: { name: string; check: string }[]
  grants: Grants
}

interface ManifestFunction {
  kind: 'function'
  name: string
  arguments: { name: string; type: string; default: string | null }[]
  returns: string
  securityDefiner: boolean
  grants: Grants
}

type ManifestRelation = ManifestView | ManifestTable

interface ManifestStatement {
  id: string
  sql: string
  params: unknown[]
}

interface RegistryEntry {
  key: string
  type: string
  allowedValues: unknown[] | null
  min: number | null
  max: number | null
  sinceContract: number
  description: string
}

interface Manifest {
  contractVersion: number
  schema: string
  schemaGrants: Grants
  viewOptions: { security_barrier: boolean; security_invoker: boolean }
  notification: { channel: string; payloadVersion: number; kinds: string[]; pingChannelPrefix: string }
  objects: (ManifestRelation | ManifestFunction)[]
  statements: ManifestStatement[]
  settings: RegistryEntry[]
}

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
const SCHEMA = `"${manifest.schema}"`
const relations = manifest.objects.filter((object): object is ManifestRelation => object.kind !== 'function')
const functions = manifest.objects.filter((object): object is ManifestFunction => object.kind === 'function')

function statement(id: string): ManifestStatement {
  const found = manifest.statements.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`the manifest has no statement ${id}`)
  return found
}

function signatureOf(fn: ManifestFunction): string {
  return `${SCHEMA}.${fn.name}(${fn.arguments.map((argument) => argument.type).join(', ')})`
}

function codeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : `no SQLSTATE: ${error instanceof Error ? error.message : String(error)}`
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

// An lsb1 envelope. The database checks only its format, never its content.
function envelope(kid: string = hex(8)): string {
  return `lsb1.${kid}.${randomBytes(32).toString('base64url')}.${randomBytes(40).toString('base64url')}`
}

interface ConnectionFields {
  environment?: string | null
  groupName?: string | null
  color?: string | null
  writeSecret?: string | null
}

// Inserts an active connection as Platform writes it, with each optional field NULL unless given, and returns its id.
async function insertConnection(client: Client, fields: ConnectionFields = {}): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO platform.database_connections (id, "tenantId", name, engine, environment, "groupName", color, definition, "readSecret", "writeSecret", "createdById")
     VALUES ($1, $2, 'Orders', 'postgres', $3, $4, $5, '{"host": "orders.db.internal", "database": "orders"}', $6, $7, $8)`,
    [id, TENANT_ID, fields.environment ?? null, fields.groupName ?? null, fields.color ?? null, envelope(), fields.writeSecret ?? null, USER_ID],
  )
  return id
}

// Inserts a grant of the subject on the connection, open-ended unless it expires, and returns its id.
async function insertGrant(client: Client, connectionId: string, subject: string, level: string, expiresAt: Date | null = null): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO platform.connection_grants (id, "connectionId", subject, "subjectUsername", level, "expiresAt", "grantedById")
     VALUES ($1, $2, $3, 'alice', $4, $5, $6)`,
    [id, connectionId, subject, level, expiresAt, USER_ID],
  )
  return id
}

async function setSetting(client: Client, key: string, value: unknown): Promise<void> {
  await client.query(
    `INSERT INTO platform.studio_settings (key, value, "updatedBy") VALUES ($1, $2::jsonb, 'system:seed')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedBy" = EXCLUDED."updatedBy"`,
    [key, JSON.stringify(value)],
  )
}

async function insertRevocation(client: Client, subject: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.session_revocations (subject, reason, "createdById") VALUES ($1, 'admin', $2) RETURNING id`,
    [subject, USER_ID],
  )
  return result.rows[0].id
}

async function insertCanary(client: Client): Promise<string> {
  const kid = hex(8)
  await client.query('INSERT INTO platform.seal_canary (kid, envelope) VALUES ($1, $2)', [kid, envelope(kid)])
  return kid
}

// How Platform puts a value into a closed vocabulary of a read view: a write behind the view as libredb_platform, after
// which the view shows the value. A closed vocabulary that a later manifest adds to a read view needs an entry here.
const PLATFORM_WRITERS: Record<string, (client: Client, value: string) => Promise<unknown>> = {
  'connections_v1.environment': async (client, value) => {
    const id = await insertConnection(client, { environment: value })
    const view = await client.query(`SELECT environment FROM ${SCHEMA}.connections_v1 WHERE connection_id = $1`, [id])
    return view.rows[0]?.environment
  },
  // level is write only on a connection with a write secret.
  'grants_v1.level': async (client, value) => {
    const connectionId = await insertConnection(client, { writeSecret: envelope() })
    const subject = randomUUID()
    await insertGrant(client, connectionId, subject, value)
    const view = await client.query(`SELECT level FROM ${SCHEMA}.grants_v1 WHERE subject = $1 AND connection_id = $2`, [subject, connectionId])
    return view.rows[0]?.level
  },
}

// The rows Studio writes into a table or a view: the column list and, row by row, the sample parameters of the manifest
// statement that inserts into it, or into the view over it.
function sampleRows(relation: string): Record<string, unknown>[] {
  const target = relations.find((object) => object.kind === 'view' && object.over === relation)?.name ?? relation
  const rows: Record<string, unknown>[] = []
  for (const { sql, params } of manifest.statements) {
    const insert = /^INSERT INTO "[^"]+"\.(\w+) \(([^)]+)\) VALUES /.exec(sql)
    if (insert === null || insert[1] !== target) continue
    const columns = insert[2].split(',').map((column) => column.trim())
    for (let offset = 0; offset < params.length; offset += columns.length) {
      rows.push(Object.fromEntries(columns.map((column, index) => [column, params[offset + index]])))
    }
  }
  return rows
}

// Inserts the row in a savepoint that is always rolled back, and returns the SQLSTATE of the refusal, or null.
// PostgreSQL checks the CHECKs before it looks for a conflict, so ON CONFLICT DO NOTHING keeps a sample row that is
// already stored from counting as a refusal.
async function tryInsert(client: Client, relation: string, row: Record<string, unknown>): Promise<string | null> {
  const columns = Object.keys(row)
  await client.query('SAVEPOINT conformance')
  try {
    await client.query(
      `INSERT INTO ${SCHEMA}.${relation} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})
       ON CONFLICT DO NOTHING`,
      columns.map((column) => row[column]),
    )
    return null
  } catch (error) {
    return codeOf(error)
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT conformance')
  }
}

// Runs a Platform writer in a savepoint that is always rolled back: the value the view then shows, or the SQLSTATE of the refusal.
async function tryWrite(client: Client, writer: (client: Client, value: string) => Promise<unknown>, value: string): Promise<{ shown?: unknown; refused?: string }> {
  await client.query('SAVEPOINT conformance')
  try {
    return { shown: await writer(client, value) }
  } catch (error) {
    return { refused: codeOf(error) }
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT conformance')
  }
}

// The distinct kinds of the notifications committed since the last flush, after checking that each payload is the
// manifest's {"v":<payloadVersion>,"kind":...}. Payloads are compared parsed, because json_build_object adds spaces.
async function kindsOf(listener: BridgeListener): Promise<string[]> {
  const payloads = await listener.flush()
  for (const payload of payloads) {
    expect(payload).toEqual({ v: manifest.notification.payloadVersion, kind: expect.any(String) })
  }
  return [...new Set(payloads.map((payload) => (payload as { kind: string }).kind))].sort()
}

// The privileges PostgreSQL 15 has on each kind of object, so that a role holding one the manifest leaves out shows too.
// MAINTAIN, new in PostgreSQL 17, is left out, because PostgreSQL 15 refuses the name.
const PRIVILEGES = {
  schema: ['USAGE', 'CREATE'],
  relation: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  function: ['EXECUTE'],
}
type PrivilegeKind = keyof typeof PRIVILEGES
const PRIVILEGE_CHECKS: Record<PrivilegeKind, string> = {
  schema: 'has_schema_privilege',
  relation: 'has_table_privilege',
  function: 'has_function_privilege',
}

// Checks the database after `prisma migrate deploy` against the manifest of the pinned Studio build: a Platform change
// whose bridge objects drift from that manifest fails here.
describe('bridge contract v1 conforms to the vendored Studio manifest', () => {
  let superuser: Client
  let owner: Client
  let platform: Client
  let studio: Client
  // A connection with every optional field and a write secret.
  let fullConnection: string

  beforeAll(async () => {
    await createFreshDatabase(DATABASE)
    superuser = await connectSuperuser(DATABASE)
    owner = await connectOwner(DATABASE)
    platform = await connectPlatform(DATABASE)
    studio = await connectStudio(DATABASE)

    // Rows behind every read view, written as libredb_platform as Platform writes them, so each view has rows, and each
    // column a view computes holds a value and, where the manifest allows it, a NULL.
    await platform.query(`INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ($1, $1, 'Conformance', now())`, [PLAN_ID])
    await platform.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, 'Conformance', $1, $2, now())`,
      [TENANT_ID, PLAN_ID],
    )
    await platform.query(`INSERT INTO platform.users (id, email, "updatedAt") VALUES ($1, $2, now())`, [USER_ID, `${USER_ID}@libredb.test`])
    fullConnection = await insertConnection(platform, { environment: 'production', groupName: 'Sales', color: '#336699', writeSecret: envelope() })
    // Every optional field NULL.
    const bareConnection = await insertConnection(platform)
    const alice = randomUUID()
    const bob = randomUUID()
    // An open-ended write, a write downgraded to read on a connection without a write secret, and an expiring read.
    await insertGrant(platform, fullConnection, alice, 'write')
    await insertGrant(platform, bareConnection, alice, 'write', new Date(Date.now() + DAY_MS))
    await insertGrant(platform, bareConnection, bob, 'read', new Date(Date.now() + DAY_MS))
    await setSetting(platform, 'queryLog.statementCapture', 'redacted')
    await insertRevocation(platform, bob)
    await insertCanary(platform)
  })

  afterAll(async () => {
    await Promise.all([superuser, owner, platform, studio].map((client) => client?.end()))
  })

  // The table column behind each output column of a view, from the origin PostgreSQL reports for every column of the
  // view's own query (the table OID and column number of RowDescription). A column the view computes has none.
  async function originsOf(view: string): Promise<Map<string, { table: string; column: string; notNull: boolean }>> {
    const definition = await superuser.query<{ sql: string }>('SELECT pg_get_viewdef(to_regclass($1)) AS sql', [`${SCHEMA}.${view}`])
    const sql = definition.rows[0].sql.trim().replace(/;$/, '')
    // A column read through an outer join can be NULL although its table column is NOT NULL.
    if (/\b(LEFT|RIGHT|FULL)\s+(OUTER\s+)?JOIN\b/i.test(sql)) {
      throw new Error(`${view} reads through an outer join, so the nullability of its columns cannot come from their tables`)
    }
    const result = await superuser.query(`SELECT * FROM (${sql}) AS v LIMIT 0`)
    const origins = new Map<string, { table: string; column: string; notNull: boolean }>()
    for (const field of result.fields) {
      if (field.tableID === 0) continue
      const column = await superuser.query<{ table: string; column: string; notNull: boolean }>(
        'SELECT attrelid::regclass::text AS table, attname AS column, attnotnull AS "notNull" FROM pg_attribute WHERE attrelid = $1 AND attnum = $2',
        [field.tableID, field.columnID],
      )
      origins.set(field.name, column.rows[0])
    }
    return origins
  }

  interface ColumnShape {
    name: string
    type: string
    nullable: boolean | string
    reads?: string
  }

  // The columns of a relation in order, each with its type, written as the manifest names it when the base type matches
  // (atttypid = '<type>'::regtype, so precision is ignored), and its nullability.
  // PostgreSQL records no NOT NULL for a view column (GOVERNANCE.md), so a view column has the nullability of the table
  // column it reads, and a column the view computes is nullable when its rows hold a NULL.
  async function columnsOf(object: ManifestRelation): Promise<ColumnShape[]> {
    const declared = new Map(object.columns.map((column) => [column.name, column.type]))
    const attributes = await superuser.query<{ name: string; type: string; typeMatches: boolean | null; notNull: boolean }>(
      `SELECT a.attname AS name, format_type(a.atttypid, NULL) AS type, a.atttypid = m.type::regtype AS "typeMatches", a.attnotnull AS "notNull"
         FROM pg_attribute a
         LEFT JOIN unnest($2::text[], $3::text[]) AS m(name, type) ON m.name = a.attname
        WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [`${SCHEMA}.${object.name}`, [...declared.keys()], [...declared.values()]],
    )
    const origins = object.kind === 'view' ? await originsOf(object.name) : new Map()

    const columns: ColumnShape[] = []
    for (const attribute of attributes.rows) {
      const shape: ColumnShape = {
        name: attribute.name,
        type: attribute.typeMatches ? (declared.get(attribute.name) as string) : attribute.type,
        nullable: !attribute.notNull,
      }
      if (object.kind === 'view') {
        const origin = origins.get(attribute.name)
        if (origin !== undefined) {
          shape.nullable = !origin.notNull
        } else {
          const rows = await superuser.query<{ total: number; nulls: number }>(
            `SELECT count(*)::int AS total, count(*) FILTER (WHERE "${attribute.name}" IS NULL)::int AS nulls FROM ${SCHEMA}.${object.name}`,
          )
          const { total, nulls } = rows.rows[0]
          shape.nullable = nulls > 0 ? true : total > 0 ? false : 'unknown: the view has no rows'
        }
        if (object.over !== null) shape.reads = origin === undefined ? 'computed' : `${origin.table}.${origin.column}`
      }
      columns.push(shape)
    }
    return columns
  }

  function expectedColumns(object: ManifestRelation): ColumnShape[] {
    return object.columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      ...(object.kind === 'view' && object.over !== null ? { reads: `${manifest.schema}.${object.over}.${column.name}` } : {}),
    }))
  }

  async function primaryKeyOf(table: string): Promise<string[]> {
    const result = await superuser.query<{ name: string }>(
      `SELECT a.attname AS name
         FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = to_regclass($1) AND c.contype = 'p'
        ORDER BY k.position`,
      [`${SCHEMA}.${table}`],
    )
    return result.rows.map((row) => row.name)
  }

  // The CHECK constraints of a table as PostgreSQL prints them, each one the manifest names prefixed with its name.
  async function printedChecks(relation: string, names: string[]): Promise<string[]> {
    const result = await superuser.query<{ name: string; definition: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'c'`,
      [relation],
    )
    return result.rows.map((row) => (names.includes(row.name) ? `${row.name}: ${row.definition}` : row.definition)).sort()
  }

  // The column CHECKs and named constraints of a manifest table, added to an empty copy of the database's table and
  // printed by PostgreSQL, so both sides are parsed and printed alike.
  async function manifestChecks(table: ManifestTable): Promise<string[]> {
    const names = table.constraints.map((constraint) => constraint.name)
    await superuser.query('BEGIN')
    try {
      await superuser.query(`CREATE TEMPORARY TABLE conformance_probe (LIKE ${SCHEMA}.${table.name})`)
      for (const column of table.columns) {
        if (column.check !== null) await superuser.query(`ALTER TABLE conformance_probe ADD CHECK (${column.check.sql})`)
      }
      for (const constraint of table.constraints) {
        await superuser.query(`ALTER TABLE conformance_probe ADD CONSTRAINT "${constraint.name}" CHECK (${constraint.check})`)
      }
      return await printedChecks('conformance_probe', names)
    } finally {
      await superuser.query('ROLLBACK')
    }
  }

  async function functionShape(fn: ManifestFunction): Promise<Record<string, unknown>> {
    const result = await superuser.query<{ returnsMatches: boolean; returns: string; securityDefiner: boolean; names: string[] | null; defaults: (string | null)[] }>(
      `SELECT p.prorettype = $2::regtype AS "returnsMatches", format_type(p.prorettype, NULL) AS returns,
              p.prosecdef AS "securityDefiner", p.proargnames AS names,
              ARRAY(SELECT pg_get_function_arg_default(p.oid, n) FROM generate_series(1, p.pronargs) AS n ORDER BY n) AS defaults
         FROM pg_proc p
        WHERE p.oid = to_regprocedure($1)`,
      [signatureOf(fn), fn.returns],
    )
    if (result.rows.length === 0) return { signature: `${signatureOf(fn)} is missing` }
    const [row] = result.rows
    return {
      signature: signatureOf(fn),
      returns: row.returnsMatches ? fn.returns : row.returns,
      securityDefiner: row.securityDefiner,
      arguments: (row.names ?? []).map((name, index) => ({ name, default: row.defaults[index] })),
    }
  }

  async function heldBy(role: string, kind: PrivilegeKind, target: string): Promise<string[]> {
    const result = await superuser.query<{ privilege: string }>(
      `SELECT p.privilege FROM unnest($3::text[]) WITH ORDINALITY AS p(privilege, position)
        WHERE ${PRIVILEGE_CHECKS[kind]}($1, $2, p.privilege)
        ORDER BY p.position`,
      [role, target, PRIVILEGES[kind]],
    )
    return result.rows.map((row) => row.privilege)
  }

  interface Change {
    // Inserts a row behind the view and returns its key.
    insert(client: Client): Promise<string>
    remove(client: Client, key: string): Promise<unknown>
    // The kinds the delete sends.
    removeKinds: string[]
  }

  // One change behind each read view that notifies, written as libredb_platform.
  function changesBehind(): Record<string, Change> {
    return {
      connections_v1: {
        insert: (client) => insertConnection(client),
        remove: (client, id) => client.query('DELETE FROM platform.database_connections WHERE id = $1', [id]),
        // Deleting a connection deletes its grants through the foreign key, so it notifies both kinds.
        removeKinds: ['connections', 'grants'],
      },
      grants_v1: {
        insert: (client) => insertGrant(client, fullConnection, randomUUID(), 'read'),
        remove: (client, id) => client.query('DELETE FROM platform.connection_grants WHERE id = $1', [id]),
        removeKinds: ['grants'],
      },
      settings_v1: {
        insert: async (client) => {
          await setSetting(client, 'query.timeoutMs', 120000)
          return 'query.timeoutMs'
        },
        remove: (client, key) => client.query('DELETE FROM platform.studio_settings WHERE key = $1', [key]),
        removeKinds: ['settings'],
      },
      session_revocations_v1: {
        insert: (client) => insertRevocation(client, randomUUID()),
        remove: (client, id) => client.query('DELETE FROM platform.session_revocations WHERE id = $1', [id]),
        removeKinds: ['revocations'],
      },
      seal_canary_v1: {
        insert: (client) => insertCanary(client),
        remove: (client, kid) => client.query('DELETE FROM platform.seal_canary WHERE kid = $1', [kid]),
        removeKinds: ['canary'],
      },
    }
  }

  it('bridge.contract lists version 1 as current on channel libredb_bridge', async () => {
    // The vendored manifest is contract 1 on channel libredb_bridge.
    expect(manifest.contractVersion).toBe(1)
    expect(manifest.notification.channel).toBe('libredb_bridge')

    for (const client of [studio, platform]) {
      const contract = await client.query(statement('snapshot.contract').sql)
      expect(contract.rows).toEqual([{ version: 1, status: 'current', sunset_after: null, notify_channel: 'libredb_bridge' }])
    }
  })

  it('every manifest object and column exists with the listed base type and nullability', async () => {
    for (const object of relations) {
      const relation = await superuser.query<{ kind: string; options: string[] | null }>(
        `SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'r' THEN 'table' ELSE c.relkind::text END AS kind, c.reloptions AS options
           FROM pg_class c
          WHERE c.oid = to_regclass($1)`,
        [`${SCHEMA}.${object.name}`],
      )
      expect(relation.rows.map((row) => row.kind), `${object.name} kind`).toEqual([object.kind])
      expect(await columnsOf(object), `${object.name} columns`).toEqual(expectedColumns(object))

      if (object.kind === 'view') {
        const options = [
          `security_barrier=${manifest.viewOptions.security_barrier}`,
          `security_invoker=${manifest.viewOptions.security_invoker}`,
          ...(object.checkOption === null ? [] : [`check_option=${object.checkOption}`]),
        ]
        expect([...(relation.rows[0].options ?? [])].sort(), `${object.name} options`).toEqual(options.sort())
      } else {
        expect(await primaryKeyOf(object.name), `${object.name} primary key`).toEqual(object.primaryKey)
        const names = object.constraints.map((constraint) => constraint.name)
        expect(await printedChecks(`${SCHEMA}.${object.name}`, names), `${object.name} CHECKs`).toEqual(await manifestChecks(object))
      }
    }

    for (const fn of functions) {
      expect(await functionShape(fn), fn.name).toEqual({
        signature: signatureOf(fn),
        returns: fn.returns,
        securityDefiner: fn.securityDefiner,
        arguments: fn.arguments.map((argument) => ({ name: argument.name, default: argument.default })),
      })
    }
  })

  it('every grant the manifest requires holds', async () => {
    // Each runtime role holds every privilege the manifest lists on each object, and none it leaves out.
    const targets: { key: string; kind: PrivilegeKind; target: string; grants: Grants }[] = [
      { key: `schema ${manifest.schema}`, kind: 'schema', target: manifest.schema, grants: manifest.schemaGrants },
      ...relations.map((object) => ({ key: object.name, kind: 'relation' as const, target: `${SCHEMA}.${object.name}`, grants: object.grants })),
      ...functions.map((fn) => ({ key: fn.name, kind: 'function' as const, target: signatureOf(fn), grants: fn.grants })),
    ]
    const held: Record<string, Grants> = {}
    const expected: Record<string, Grants> = {}
    for (const { key, kind, target, grants } of targets) {
      held[key] = {}
      expected[key] = {}
      for (const role of new Set(['libredb_studio', 'libredb_platform', ...Object.keys(grants)])) {
        held[key][role] = await heldBy(role, kind, target)
        expected[key][role] = [...(grants[role] ?? [])].sort((a, b) => PRIVILEGES[kind].indexOf(a) - PRIVILEGES[kind].indexOf(b))
      }
    }
    expect(held).toEqual(expected)
  })

  it('every closed vocabulary accepts its listed values and refuses another', async () => {
    const vocabularies = relations.flatMap((object) =>
      object.columns
        .filter((column) => column.check?.kind === 'values')
        .map((column) => ({ object, column: column.name, values: column.check?.values ?? [] })),
    )
    expect(vocabularies.length).toBeGreaterThan(0)

    for (const { object, column, values } of vocabularies) {
      const key = `${object.name}.${column}`
      expect(values, key).not.toContain(OUTSIDE)

      if (object.name === 'contract') {
        // Only migrations write the rows of bridge.contract, so its vocabulary holds for the rows it publishes.
        const published = await superuser.query(`SELECT ${column} AS value FROM ${SCHEMA}.contract`)
        expect(published.rows.length, `${key} published rows`).toBeGreaterThan(0)
        expect(published.rows.filter((row) => !values.includes(row.value)), key).toEqual([])
        continue
      }

      if (object.kind === 'view' && !(object.grants.libredb_studio ?? []).includes('INSERT')) {
        // A read view: Platform writes the rows behind it.
        const writer = PLATFORM_WRITERS[key]
        if (writer === undefined) throw new Error(`this test has no Platform writer for the closed vocabulary ${key}`)
        await platform.query('BEGIN')
        try {
          for (const value of values) {
            expect(await tryWrite(platform, writer, value), `${key} = ${value}`).toEqual({ shown: value })
          }
          // Refused by a CHECK, an enum or another rule of the rows behind the view: SQLSTATE class 22 or 23.
          expect(await tryWrite(platform, writer, OUTSIDE), `${key} = ${OUTSIDE}`).toEqual({ refused: expect.stringMatching(/^2[23]/) })
        } finally {
          await platform.query('ROLLBACK')
        }
        continue
      }

      // A table, written here as its owner, or a view Studio inserts into, written as libredb_studio: with the sample
      // rows of the manifest, the first of which takes every listed value.
      const client = object.kind === 'table' ? owner : studio
      const rows = sampleRows(object.name)
      expect(rows.length, `${key} sample rows`).toBeGreaterThan(0)
      await client.query('BEGIN')
      try {
        let best = { row: rows[0], accepted: [] as string[] }
        for (const row of rows) {
          const accepted: string[] = []
          for (const value of values) {
            if ((await tryInsert(client, object.name, { ...row, [column]: value })) === null) accepted.push(value)
          }
          if (accepted.length > best.accepted.length) best = { row, accepted }
          if (accepted.length === values.length) break
        }
        expect(best.accepted, key).toEqual(values)
        expect(await tryInsert(client, object.name, { ...best.row, [column]: OUTSIDE }), `${key} = ${OUTSIDE}`).toBe(CHECK_VIOLATION)
      } finally {
        await client.query('ROLLBACK')
      }
    }
  })

  it('every statement of the manifest runs as libredb_studio', async () => {
    // A client of its own, so that its LISTENs end with it.
    const client = await connectStudio(DATABASE)
    const pings: string[] = []
    client.on('notification', (notification) => {
      if (notification.channel.startsWith(manifest.notification.pingChannelPrefix)) pings.push(notification.payload ?? '')
    })
    try {
      // Twice, as Studio repeats them: the next snapshot, the next beat, and a retried batch of events with the same ids.
      for (let round = 1; round <= 2; round++) {
        for (const { id, sql, params } of manifest.statements) {
          const result = await client.query(sql, params).catch((error: unknown) => {
            throw new Error(`${id} failed as libredb_studio: ${error instanceof Error ? error.message : String(error)}`)
          })
          // Every read view has rows behind it, so every read returns some, which a view that hides its rows would not.
          if (/^SELECT\b/.test(sql)) expect(result.rowCount, `${id} rows`).toBeGreaterThan(0)
        }
      }

      // The ping reached the listener's own channel once per round.
      const nonce = statement('listener.ping').params[1]
      expect(pings).toEqual([nonce, nonce])

      // Each insert stored its sample rows once, so the retried batch added no duplicate.
      for (const table of relations) {
        if (table.kind !== 'table') continue
        const rows = sampleRows(table.name)
        if (rows.length === 0) continue
        expect(table.primaryKey, table.name).toHaveLength(1)
        const [key] = table.primaryKey
        const keys = rows.map((row) => row[key])
        const stored = await superuser.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${SCHEMA}.${table.name} WHERE ${key} = ANY($1)`,
          [keys],
        )
        expect(stored.rows[0].count, table.name).toBe(new Set(keys).size)
      }

      // Studio reads none of Platform's own tables and none of the query events it writes.
      await expectSqlState(client.query('SELECT id FROM platform.users LIMIT 1'), INSUFFICIENT_PRIVILEGE)
      await expectSqlState(client.query(`SELECT event_id FROM ${SCHEMA}.query_event LIMIT 1`), INSUFFICIENT_PRIVILEGE)
    } finally {
      await client.end()
    }
  })

  it("the allowlist equals the manifest's settings registry", async () => {
    const allowlist = await platform.query(
      `SELECT key, "valueType", "allowedValues", "minValue", "maxValue", "sinceContract", description
         FROM platform.studio_setting_keys
        ORDER BY key COLLATE "C"`,
    )
    expect(
      allowlist.rows.map((row) => ({
        key: row.key,
        type: row.valueType,
        allowedValues: row.allowedValues,
        min: row.minValue === null ? null : Number(row.minValue),
        max: row.maxValue === null ? null : Number(row.maxValue),
        sinceContract: row.sinceContract,
        description: row.description,
      })),
    ).toEqual(
      manifest.settings
        .map(({ key, type, allowedValues, min, max, sinceContract, description }) => ({ key, type, allowedValues, min, max, sinceContract, description }))
        .sort((a, b) => (a.key < b.key ? -1 : 1)),
    )
  })

  it('a change behind each view with a notification kind sends that kind on the channel of the manifest', async () => {
    expect(manifest.notification.channel).toBe(BRIDGE_CHANNEL)
    const changes = changesBehind()
    const listener = await listenBridge('studio', DATABASE)
    try {
      for (const view of relations) {
        if (view.kind !== 'view' || view.notifyKind === null) continue
        const change = changes[view.name]
        if (change === undefined) throw new Error(`this test has no change behind ${view.name}, which notifies ${view.notifyKind}`)
        expect(manifest.notification.kinds, view.name).toContain(view.notifyKind)
        await listener.flush()

        const key = await change.insert(platform)
        expect(await kindsOf(listener), `insert behind ${view.name}`).toEqual([view.notifyKind])
        await change.remove(platform, key)
        // Compared as a set, because one statement can notify several kinds in no fixed order.
        expect(await kindsOf(listener), `delete behind ${view.name}`).toEqual([...change.removeKinds].sort())
      }
    } finally {
      await listener.close()
    }
  })
})
