import { randomBytes, randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPlatform, connectStudio, connectSuperuser } from './connect'
import { listenBridge } from './listen'
import { expectSqlState } from './sqlstate'

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'
const INVALID_TEXT_REPRESENTATION = '22P02'

const DAY_MS = 24 * 60 * 60 * 1000

// Every row of this file belongs to this tenant, plan and user, so the cleanup removes exactly them.
const MARKER = `bridge-grants-${randomUUID().slice(0, 8)}`
const TENANT_ID = `${MARKER}-tenant`
const PLAN_ID = `${MARKER}-plan`
const USER_ID = `${MARKER}-user`

interface Connection {
  id: string
  writeSecret: string | null
  active: boolean
  deletedAt: Date | null
}

interface Grant {
  id: string
  connectionId: string
  subjectKind: string
  subject: string
  subjectUsername: string
  subjectEmail: string | null
  level: string
  expiresAt: Date | null
  grantedAt: Date
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

// An lsb1 envelope for a random kid. The database checks only its format, never its content.
function envelope(): string {
  return `lsb1.${hex(8)}.${randomBytes(32).toString('base64url')}.${randomBytes(40).toString('base64url')}`
}

// An active connection with a read credential only.
function connection(overrides: Partial<Connection> = {}): Connection {
  return { id: randomUUID(), writeSecret: null, active: true, deletedAt: null, ...overrides }
}

async function insertConnection(client: Client, row: Connection): Promise<void> {
  await client.query(
    `INSERT INTO platform.database_connections (id, "tenantId", name, engine, definition, "readSecret", "writeSecret", active, "deletedAt", "createdById")
     VALUES ($1, $2, 'Orders', 'postgres', '{"host": "orders.db.internal", "database": "orders"}', $3, $4, $5, $6, $7)`,
    [row.id, TENANT_ID, envelope(), row.writeSecret, row.active, row.deletedAt, USER_ID],
  )
}

// An open-ended read grant to a new subject, a Keycloak user id, as Platform writes it.
function grant(connectionId: string, overrides: Partial<Grant> = {}): Grant {
  return {
    id: randomUUID(),
    connectionId,
    subjectKind: 'user',
    subject: randomUUID(),
    subjectUsername: 'alice',
    subjectEmail: 'alice@example.com',
    level: 'read',
    expiresAt: null,
    grantedAt: new Date(),
    ...overrides,
  }
}

const GRANT_COLUMNS = '(id, "connectionId", "subjectKind", subject, "subjectUsername", "subjectEmail", level, "expiresAt", "grantedById", "grantedAt")'

function grantValues(row: Grant): unknown[] {
  return [row.id, row.connectionId, row.subjectKind, row.subject, row.subjectUsername, row.subjectEmail, row.level, row.expiresAt, USER_ID, row.grantedAt]
}

async function insertGrant(client: Client, row: Grant): Promise<void> {
  await client.query(`INSERT INTO platform.connection_grants ${GRANT_COLUMNS} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, grantValues(row))
}

const SNAPSHOT_COLUMNS = 'subject, connection_id, level, expires_at, downgraded, granted_at'

// The rows of bridge.grants_v1 for the subjects, with the columns of the snapshot query, ordered by subject and connection.
async function viewRows(client: Client, subjects: string[]): Promise<Record<string, unknown>[]> {
  const result = await client.query(
    `SELECT ${SNAPSHOT_COLUMNS} FROM "bridge".grants_v1 WHERE subject = ANY($1) ORDER BY subject COLLATE "C", connection_id COLLATE "C"`,
    [subjects],
  )
  return result.rows
}

// The row of bridge.grants_v1 for a single grant row of the subject on the connection.
function viewRow(row: Grant, level: string, downgraded: boolean = false): Record<string, unknown> {
  return {
    subject: row.subject,
    connection_id: row.connectionId,
    level,
    expires_at: row.expiresAt,
    downgraded,
    granted_at: row.grantedAt,
  }
}

function byConnection(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => (String(a.connection_id) < String(b.connection_id) ? -1 : 1))
}

// Asserts that the operation fails with SQLSTATE 23514 raised by the named CHECK constraint.
async function expectCheckViolation(operation: Promise<unknown>, constraint: string): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error, `expected the CHECK constraint ${constraint} to refuse the row`).toMatchObject({ code: CHECK_VIOLATION, constraint })
}

// The privileges of an ACL other than the owner's own, as grantee:privilege, sorted.
const GRANTS_OF = (acl: string, owner: string) => `
  coalesce((SELECT array_agg(entry ORDER BY entry COLLATE "C")
              FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type AS entry
                      FROM aclexplode(${acl}) a
                     WHERE a.grantee <> ${owner}) entries), '{}')`

// Applied by tests/db/global-setup.ts, which runs `prisma migrate deploy` as libredb_owner.
describe('platform.connection_grants, its database rules and bridge.grants_v1', () => {
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
    // Deleting the connections deletes their grants, which reference the user.
    await superuser.query('DELETE FROM platform.database_connections WHERE "tenantId" = $1', [TENANT_ID])
    await superuser.query('DELETE FROM platform.tenants WHERE id = $1', [TENANT_ID])
    await superuser.query('DELETE FROM platform.plan_configs WHERE id = $1', [PLAN_ID])
    await superuser.query('DELETE FROM platform.users WHERE id = $1', [USER_ID])
    await studio.end()
    await platform.end()
    await superuser.end()
  })

  it('expired grants and grants on inactive or deleted connections are hidden', async () => {
    const active = connection()
    const inactive = connection({ active: false })
    const deleted = connection({ deletedAt: new Date() })
    for (const row of [active, inactive, deleted]) {
      await insertConnection(platform, row)
    }

    const subject = randomUUID()
    const shown = grant(active.id, { subject, expiresAt: new Date(Date.now() + DAY_MS) })
    const onInactive = grant(inactive.id, { subject })
    const onDeleted = grant(deleted.id, { subject })
    // An expired grant still satisfies the CHECK, because it expired after it was granted.
    const expired = grant(active.id, { grantedAt: new Date(Date.now() - 2 * DAY_MS), expiresAt: new Date(Date.now() - DAY_MS) })
    for (const row of [shown, onInactive, onDeleted, expired]) {
      await insertGrant(platform, row)
    }

    for (const client of [studio, platform]) {
      expect(await viewRows(client, [subject, expired.subject])).toEqual([viewRow(shown, 'read')])
    }

    // The view hides these rows without deleting them.
    const stored = await platform.query('SELECT count(*)::int AS count FROM platform.connection_grants WHERE id = ANY($1)', [
      [shown.id, onInactive.id, onDeleted.id, expired.id],
    ])
    expect(stored.rows).toEqual([{ count: 4 }])

    // Deactivating or deleting a connection later hides its grants at once.
    await platform.query('UPDATE platform.database_connections SET active = false WHERE id = $1', [active.id])
    expect(await viewRows(studio, [subject])).toEqual([])
    await platform.query('UPDATE platform.database_connections SET active = true, "deletedAt" = now() WHERE id = $1', [active.id])
    expect(await viewRows(studio, [subject])).toEqual([])
    await platform.query('UPDATE platform.database_connections SET "deletedAt" = NULL WHERE id = $1', [active.id])
    expect(await viewRows(studio, [subject])).toEqual([viewRow(shown, 'read')])
  })

  it('a write grant on a connection without a write secret appears as read with downgraded true', async () => {
    const readOnly = connection()
    const writable = connection({ writeSecret: envelope() })
    for (const row of [readOnly, writable]) {
      await insertConnection(platform, row)
    }

    const subject = randomUUID()
    const downgraded = grant(readOnly.id, { subject, level: 'write' })
    const write = grant(writable.id, { subject, level: 'write' })
    const read = grant(readOnly.id)
    for (const row of [downgraded, write, read]) {
      await insertGrant(platform, row)
    }

    expect(await viewRows(studio, [subject])).toEqual(byConnection([viewRow(downgraded, 'read', true), viewRow(write, 'write')]))
    // A read grant was never downgraded.
    expect(await viewRows(studio, [read.subject])).toEqual([viewRow(read, 'read')])

    // Removing the write credential downgrades every write grant on the connection at once.
    await platform.query('UPDATE platform.database_connections SET "writeSecret" = NULL WHERE id = $1', [writable.id])
    expect(await viewRows(studio, [subject])).toEqual(byConnection([viewRow(downgraded, 'read', true), viewRow(write, 'read', true)]))
  })

  it('an open-ended grant has expires_at null', async () => {
    const readOnly = connection()
    const writable = connection({ writeSecret: envelope() })
    for (const row of [readOnly, writable]) {
      await insertConnection(platform, row)
    }

    const until = new Date(Date.now() + 7 * DAY_MS)
    const openRead = grant(writable.id)
    const openWrite = grant(writable.id, { level: 'write' })
    const timedRead = grant(writable.id, { expiresAt: until })
    const timedWrite = grant(writable.id, { level: 'write', expiresAt: until })
    // A downgraded grant keeps its expiry, which is when its read access stops.
    const timedDowngraded = grant(readOnly.id, { level: 'write', expiresAt: until })
    const rows = [openRead, openWrite, timedRead, timedWrite, timedDowngraded]
    for (const row of rows) {
      await insertGrant(platform, row)
    }

    for (const [row, level, downgraded, expiresAt] of [
      [openRead, 'read', false, null],
      [openWrite, 'write', false, null],
      [timedRead, 'read', false, until],
      [timedWrite, 'write', false, until],
      [timedDowngraded, 'read', true, until],
    ] as const) {
      expect(await viewRows(studio, [row.subject])).toEqual([{ ...viewRow(row, level, downgraded), expires_at: expiresAt }])
    }
  })

  it('a second grant row for the same connection and subject is refused (23505)', async () => {
    const first = connection({ writeSecret: envelope() })
    const second = connection()
    for (const row of [first, second]) {
      await insertConnection(platform, row)
    }

    const existing = grant(first.id)
    await insertGrant(platform, existing)
    const duplicate = insertGrant(platform, grant(first.id, { subject: existing.subject, level: 'write', subjectUsername: 'alice.renamed' }))
    const error = await duplicate.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error, 'expected the unique index on connectionId, subjectKind and subject to refuse the row').toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'connection_grants_connectionId_subjectKind_subject_key',
    })

    // The same subject on another connection and another subject on the same connection are grants of their own.
    const elsewhere = grant(second.id, { subject: existing.subject })
    const otherSubject = grant(first.id)
    for (const row of [elsewhere, otherSubject]) {
      await insertGrant(platform, row)
    }
    expect(await viewRows(studio, [existing.subject])).toEqual(byConnection([viewRow(existing, 'read'), viewRow(elsewhere, 'read')]))
    expect(await viewRows(studio, [otherSubject.subject])).toEqual([viewRow(otherSubject, 'read')])
  })

  it('one notification of kind grants arrives per committed statement', async () => {
    const target = connection({ writeSecret: envelope() })
    await insertConnection(platform, target)

    const listener = await listenBridge()
    const writer = await connectPlatform()
    const notification = { v: 1, kind: 'grants' }
    try {
      const first = grant(target.id)
      const second = grant(target.id)
      await writer.query(
        `INSERT INTO platform.connection_grants ${GRANT_COLUMNS}
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10), ($11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [...grantValues(first), ...grantValues(second)],
      )
      expect(await listener.flush()).toEqual([notification])

      await writer.query(`UPDATE platform.connection_grants SET level = 'write' WHERE id = ANY($1)`, [[first.id, second.id]])
      expect(await listener.flush()).toEqual([notification])

      // Nothing arrives before the commit and nothing after a rollback.
      await writer.query('BEGIN')
      await writer.query(`UPDATE platform.connection_grants SET "expiresAt" = now() + interval '1 day' WHERE id = $1`, [first.id])
      expect(await listener.flush()).toEqual([])
      await writer.query('COMMIT')
      expect(await listener.flush()).toEqual([notification])

      await writer.query('BEGIN')
      await writer.query('DELETE FROM platform.connection_grants WHERE id = $1', [second.id])
      await writer.query('ROLLBACK')
      expect(await listener.flush()).toEqual([])

      await writer.query('DELETE FROM platform.connection_grants WHERE id = ANY($1)', [[first.id, second.id]])
      expect(await listener.flush()).toEqual([notification])

      // Deleting a connection deletes its grants, and Studio hears of both changes.
      const cascaded = grant(target.id)
      await insertGrant(writer, cascaded)
      expect(await listener.flush()).toEqual([notification])
      await writer.query('DELETE FROM platform.database_connections WHERE id = $1', [target.id])
      const kinds = (await listener.flush()).map((payload) => (payload as { kind: string }).kind).sort()
      expect(kinds).toEqual(['connections', 'grants'])
      const remaining = await writer.query('SELECT id FROM platform.connection_grants WHERE id = $1', [cascaded.id])
      expect(remaining.rows).toEqual([])
    } finally {
      await writer.end()
      await listener.close()
    }

    const triggers = await superuser.query<{ definition: string }>(
      `SELECT pg_get_triggerdef(oid) AS definition
         FROM pg_trigger
        WHERE tgrelid = 'platform.connection_grants'::regclass AND NOT tgisinternal`,
    )
    expect(triggers.rows).toEqual([
      {
        definition:
          "CREATE TRIGGER bridge_notify AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON platform.connection_grants FOR EACH STATEMENT EXECUTE FUNCTION bridge.notify_change('grants')",
      },
    ])
  })

  it('libredb_studio can read bridge.grants_v1 and not platform.connection_grants', async () => {
    const target = connection()
    await insertConnection(platform, target)
    const row = grant(target.id)
    await insertGrant(platform, row)

    expect(await viewRows(studio, [row.subject])).toEqual([viewRow(row, 'read')])

    await expectSqlState(studio.query('SELECT id FROM platform.connection_grants LIMIT 1'), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(studio.query('DELETE FROM platform.connection_grants WHERE subject = $1', [row.subject]), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(
      studio.query(`INSERT INTO platform.connection_grants ${GRANT_COLUMNS} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
        ...grantValues(grant(target.id, { level: 'write' })),
      ]),
      INSUFFICIENT_PRIVILEGE,
    )
    await expectSqlState(
      studio.query(`UPDATE platform.connection_grants SET level = 'write' WHERE subject = $1`, [row.subject]),
      INSUFFICIENT_PRIVILEGE,
    )
    expect(await viewRows(platform, [row.subject])).toEqual([viewRow(row, 'read')])
  })

  it('the break-glass DELETE FROM platform.connection_grants WHERE subject = s, run as libredb_platform, removes s from bridge.grants_v1', async () => {
    const first = connection({ writeSecret: envelope() })
    const second = connection()
    for (const row of [first, second]) {
      await insertConnection(platform, row)
    }
    const subject = randomUUID()
    const revoked = [grant(first.id, { subject, level: 'write' }), grant(second.id, { subject })]
    const kept = grant(first.id, { level: 'write' })
    for (const row of [...revoked, kept]) {
      await insertGrant(platform, row)
    }
    expect(await viewRows(studio, [subject])).toHaveLength(2)

    // A session as the Platform runtime role, which `libredb-installer db-shell --as platform` opens for the
    // break-glass statements of docs/deploy/platform-runtime.md.
    const listener = await listenBridge()
    const operator = await connectPlatform()
    try {
      const deleted = await operator.query(`DELETE FROM platform.connection_grants WHERE subject = '${subject}'`)
      expect(deleted.rowCount).toBe(2)
      expect(await listener.flush()).toEqual([{ v: 1, kind: 'grants' }])
    } finally {
      await operator.end()
      await listener.close()
    }

    expect(await viewRows(studio, [subject])).toEqual([])
    expect(await viewRows(studio, [kept.subject])).toEqual([viewRow(kept, 'write')])
  })

  it('a subject kind other than user, a subject outside 1 to 512 characters, an expiry not after the grant time and an unknown level are refused', async () => {
    const target = connection()
    await insertConnection(platform, target)

    // Keycloak groups as grant subjects wait for a later version.
    await expectCheckViolation(insertGrant(platform, grant(target.id, { subjectKind: 'group' })), 'connection_grants_subjectKind_check')
    await expectCheckViolation(insertGrant(platform, grant(target.id, { subject: '' })), 'connection_grants_subject_check')
    await expectCheckViolation(insertGrant(platform, grant(target.id, { subject: 'x'.repeat(513) })), 'connection_grants_subject_check')
    const grantedAt = new Date()
    await expectCheckViolation(
      insertGrant(platform, grant(target.id, { grantedAt, expiresAt: grantedAt })),
      'connection_grants_expiry_after_grant',
    )
    await expectCheckViolation(
      insertGrant(platform, grant(target.id, { grantedAt, expiresAt: new Date(grantedAt.getTime() - DAY_MS) })),
      'connection_grants_expiry_after_grant',
    )
    await expectSqlState(insertGrant(platform, grant(target.id, { level: 'admin' })), INVALID_TEXT_REPRESENTATION)

    // An LDAP-federated user without import has an id such as f:<component>:<username>, up to 512 characters.
    const federated = grant(target.id, { subject: `f:${randomUUID()}:`.padEnd(512, 'u'), subjectEmail: null })
    await insertGrant(platform, federated)
    expect(await viewRows(studio, [federated.subject])).toEqual([viewRow(federated, 'read')])

    // An update cannot move the expiry before the grant time either.
    await expectCheckViolation(
      platform.query(`UPDATE platform.connection_grants SET "expiresAt" = "grantedAt" - interval '1 hour' WHERE id = $1`, [federated.id]),
      'connection_grants_expiry_after_grant',
    )

    // Without subjectKind, grantedAt and updatedAt, a row is an open-ended user grant stamped with the database clock.
    // timestamptz(3) rounds that clock to the millisecond, so the stamp may lie up to half a millisecond after a later now().
    const defaulted = grant(target.id)
    await platform.query(
      `INSERT INTO platform.connection_grants (id, "connectionId", subject, "subjectUsername", level, "grantedById")
       VALUES ($1, $2, $3, 'bob', 'read', $4)`,
      [defaulted.id, target.id, defaulted.subject, USER_ID],
    )
    const stored = await platform.query(
      `SELECT "subjectKind", "subjectEmail", "expiresAt",
              "grantedAt" BETWEEN now() - interval '1 minute' AND now() + interval '1 second' AS granted_now,
              "updatedAt" = "grantedAt" AS updated_at_granted_at
         FROM platform.connection_grants
        WHERE id = $1`,
      [defaulted.id],
    )
    expect(stored.rows).toEqual([
      { subjectKind: 'user', subjectEmail: null, expiresAt: null, granted_now: true, updated_at_granted_at: true },
    ])
  })

  it('bridge.grants_v1 has the columns of the contract, belongs to libredb_owner with the view options of the contract and grants SELECT to both runtime roles only', async () => {
    // The column names and types of the contract manifest, where timestamptz is PostgreSQL's timestamp with time zone.
    const columns = await superuser.query<{ name: string; type: string }>(
      `SELECT attname AS name, format_type(atttypid, NULL) AS type
         FROM pg_attribute
        WHERE attrelid = 'bridge.grants_v1'::regclass AND attnum > 0 AND NOT attisdropped
        ORDER BY attnum`,
    )
    expect(columns.rows).toEqual([
      { name: 'subject', type: 'text' },
      { name: 'connection_id', type: 'text' },
      { name: 'level', type: 'text' },
      { name: 'expires_at', type: 'timestamp with time zone' },
      { name: 'downgraded', type: 'boolean' },
      { name: 'granted_at', type: 'timestamp with time zone' },
    ])

    const view = await superuser.query<{ owner: string; options: string[]; grants: string[] }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner, c.reloptions AS options,
              ${GRANTS_OF("coalesce(c.relacl, acldefault('r', c.relowner))", 'c.relowner')} AS grants
         FROM pg_class c
        WHERE c.oid = 'bridge.grants_v1'::regclass`,
    )
    expect(view.rows.map((row) => ({ ...row, options: [...row.options].sort() }))).toEqual([
      {
        owner: 'libredb_owner',
        options: ['security_barrier=true', 'security_invoker=false'],
        grants: ['libredb_platform:SELECT', 'libredb_studio:SELECT'],
      },
    ])

    // The runtime role has DML on the grant table through the default privileges, which the break-glass DELETE needs.
    const table = await superuser.query<{ owner: string; grants: string[] }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner,
              ${GRANTS_OF("coalesce(c.relacl, acldefault('r', c.relowner))", 'c.relowner')} AS grants
         FROM pg_class c
        WHERE c.oid = 'platform.connection_grants'::regclass`,
    )
    expect(table.rows).toEqual([
      {
        owner: 'libredb_owner',
        grants: ['libredb_platform:DELETE', 'libredb_platform:INSERT', 'libredb_platform:SELECT', 'libredb_platform:UPDATE'],
      },
    ])

    const keys = await superuser.query(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'platform.connection_grants'::regclass AND contype IN ('p', 'f')
        ORDER BY conname COLLATE "C"`,
    )
    expect(keys.rows).toEqual([
      {
        name: 'connection_grants_connectionId_fkey',
        definition: 'FOREIGN KEY ("connectionId") REFERENCES platform.database_connections(id) ON UPDATE CASCADE ON DELETE CASCADE',
      },
      {
        name: 'connection_grants_grantedById_fkey',
        definition: 'FOREIGN KEY ("grantedById") REFERENCES platform.users(id) ON UPDATE CASCADE ON DELETE RESTRICT',
      },
      { name: 'connection_grants_pkey', definition: 'PRIMARY KEY (id)' },
    ])

    const indexes = await superuser.query<{ name: string; definition: string }>(
      `SELECT indexname AS name, indexdef AS definition
         FROM pg_indexes
        WHERE schemaname = 'platform' AND tablename = 'connection_grants'
        ORDER BY indexname COLLATE "C"`,
    )
    expect(indexes.rows).toEqual([
      {
        name: 'connection_grants_connectionId_subjectKind_subject_key',
        definition:
          'CREATE UNIQUE INDEX "connection_grants_connectionId_subjectKind_subject_key" ON platform.connection_grants USING btree ("connectionId", "subjectKind", subject)',
      },
      { name: 'connection_grants_pkey', definition: 'CREATE UNIQUE INDEX connection_grants_pkey ON platform.connection_grants USING btree (id)' },
      {
        name: 'connection_grants_subject_idx',
        definition: 'CREATE INDEX connection_grants_subject_idx ON platform.connection_grants USING btree (subject)',
      },
    ])
  })
})
