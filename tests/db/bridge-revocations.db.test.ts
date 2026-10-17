import { randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPlatform, connectStudio, connectSuperuser } from './connect'
import { listenBridge } from './listen'
import { expectSqlState } from './sqlstate'

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'
const OBJECT_NOT_IN_PREREQUISITE_STATE = '55000'

const HOUR_MS = 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Every subject of this file starts with this marker, and the admin who revokes is this user, so the cleanup
// removes exactly the rows of this file.
const MARKER = `bridge-revocations-${randomUUID().slice(0, 8)}`
const USER_ID = `${MARKER}-user`

// A subject of its own for each case: a Keycloak user id is opaque text of up to 512 characters.
function newSubject(): string {
  return `${MARKER}:${randomUUID()}`
}

interface Revocation {
  subject: string
  reason: string
  revokedBefore: Date
}

async function insertRevocation(client: Client, row: Revocation): Promise<void> {
  await client.query(
    'INSERT INTO platform.session_revocations (subject, reason, "revokedBefore", "createdById") VALUES ($1, $2, $3, $4)',
    [row.subject, row.reason, row.revokedBefore, USER_ID],
  )
}

// The rows of bridge.session_revocations_v1 for the subjects, with the columns of the snapshot query.
async function viewRows(client: Client, subjects: string[]): Promise<Record<string, unknown>[]> {
  const result = await client.query(
    `SELECT subject, revoked_before FROM "bridge".session_revocations_v1 WHERE subject = ANY($1) ORDER BY subject COLLATE "C"`,
    [subjects],
  )
  return result.rows
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
describe('platform.session_revocations, its database rules and bridge.session_revocations_v1', () => {
  let superuser: Client
  let platform: Client
  let studio: Client

  beforeAll(async () => {
    superuser = await connectSuperuser()
    platform = await connectPlatform()
    studio = await connectStudio()

    await platform.query(`INSERT INTO platform.users (id, email, "updatedAt") VALUES ($1, $2, now())`, [USER_ID, `${USER_ID}@libredb.test`])
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.session_revocations WHERE subject LIKE $1', [`${MARKER}:%`])
    await superuser.query('DELETE FROM platform.users WHERE id = $1', [USER_ID])
    await studio.end()
    await platform.end()
    await superuser.end()
  })

  it('libredb_platform runs INSERT INTO platform.session_revocations (subject, reason) VALUES (s, admin) and bridge.session_revocations_v1 then lists s', async () => {
    const subject = newSubject()

    // A session as the Platform runtime role, which `libredb-installer db-shell --as platform` opens for the
    // break-glass statements of docs/deploy/platform-runtime.md.
    // The statement names no id: the database generates it.
    const listener = await listenBridge()
    const operator = await connectPlatform()
    try {
      const inserted = await operator.query(`INSERT INTO platform.session_revocations (subject, reason) VALUES ('${subject}', 'admin')`)
      expect(inserted.rowCount).toBe(1)
      expect(await listener.flush()).toEqual([{ v: 1, kind: 'revocations' }])
    } finally {
      await operator.end()
      await listener.close()
    }

    // revokedBefore and createdAt take the database clock; timestamptz(3) rounds it to the millisecond, so the stamp
    // may lie up to half a millisecond after a later now().
    const stored = await platform.query<{ id: string; revokedBefore: Date }>(
      `SELECT id, reason, "createdById", "revokedBefore",
              "revokedBefore" BETWEEN now() - interval '1 minute' AND now() + interval '1 second' AS revoked_now,
              "createdAt" = "revokedBefore" AS created_at_revoked_before
         FROM platform.session_revocations
        WHERE subject = $1`,
      [subject],
    )
    expect(stored.rows).toEqual([
      {
        id: expect.stringMatching(UUID),
        reason: 'admin',
        createdById: null,
        revokedBefore: expect.any(Date),
        revoked_now: true,
        created_at_revoked_before: true,
      },
    ])

    // Studio reads the revocation with the snapshot statement of the contract manifest.
    const snapshot = await studio.query<{ subject: string; revoked_before: Date }>(
      'SELECT subject, revoked_before FROM "bridge".session_revocations_v1',
    )
    expect(snapshot.rows.filter((row) => row.subject === subject)).toEqual([
      { subject, revoked_before: stored.rows[0].revokedBefore },
    ])
  })

  it('bridge.session_revocations_v1 returns the latest revoked_before per subject', async () => {
    const now = Date.now()
    const repeated = newSubject()
    const once = newSubject()
    const latest = new Date(now - HOUR_MS)
    // The latest revocation is not the last one inserted: the view takes the latest time, not the latest row.
    for (const row of [
      { subject: repeated, reason: 'role-removed', revokedBefore: new Date(now - 2 * HOUR_MS) },
      { subject: repeated, reason: 'admin', revokedBefore: latest },
      { subject: repeated, reason: 'user-disabled', revokedBefore: new Date(now - 3 * HOUR_MS) },
      { subject: once, reason: 'user-deleted', revokedBefore: new Date(now - HOUR_MS / 2) },
    ]) {
      await insertRevocation(platform, row)
    }

    for (const client of [studio, platform]) {
      expect(await viewRows(client, [repeated, once])).toEqual(
        [
          { subject: repeated, revoked_before: latest },
          { subject: once, revoked_before: new Date(now - HOUR_MS / 2) },
        ].sort((a, b) => (a.subject < b.subject ? -1 : 1)),
      )
    }

    // A new revocation without a time revokes every session issued until now.
    await platform.query(`INSERT INTO platform.session_revocations (subject, reason) VALUES ($1, 'admin')`, [repeated])
    const [row] = await viewRows(studio, [repeated])
    expect((row.revoked_before as Date).getTime()).toBeGreaterThan(latest.getTime())
    const stored = await platform.query('SELECT count(*)::int AS count FROM platform.session_revocations WHERE subject = $1', [repeated])
    expect(stored.rows).toEqual([{ count: 4 }])
  })

  it('a reason outside the vocabulary is refused (23514)', async () => {
    const subject = newSubject()
    const revokedBefore = new Date()

    for (const reason of ['expired', 'ADMIN', 'role_removed', '']) {
      await expectCheckViolation(insertRevocation(platform, { subject, reason, revokedBefore }), 'session_revocations_reason_check')
    }
    for (const reason of ['admin', 'user-disabled', 'user-deleted', 'role-removed']) {
      await insertRevocation(platform, { subject, reason, revokedBefore })
    }

    // A subject is the Keycloak user id: from 1 to 512 characters, as LDAP-federated ids such as f:<component>:<username> can be.
    await expectCheckViolation(insertRevocation(platform, { subject: '', reason: 'admin', revokedBefore }), 'session_revocations_subject_check')
    const tooLong = `${MARKER}:`.padEnd(513, 'u')
    await expectCheckViolation(insertRevocation(platform, { subject: tooLong, reason: 'admin', revokedBefore }), 'session_revocations_subject_check')
    const federated = `${MARKER}:f:${randomUUID()}:`.padEnd(512, 'u')
    await insertRevocation(platform, { subject: federated, reason: 'user-deleted', revokedBefore })
    expect(await viewRows(studio, [federated])).toEqual([{ subject: federated, revoked_before: revokedBefore }])

    // An update cannot move a row out of the vocabulary either.
    await expectCheckViolation(
      platform.query(`UPDATE platform.session_revocations SET reason = 'expired' WHERE subject = $1`, [federated]),
      'session_revocations_reason_check',
    )
  })

  it('one notification of kind revocations arrives per committed statement', async () => {
    const first = newSubject()
    const second = newSubject()
    const notification = { v: 1, kind: 'revocations' }

    const listener = await listenBridge()
    const writer = await connectPlatform()
    try {
      await writer.query(
        `INSERT INTO platform.session_revocations (subject, reason) VALUES ($1, 'admin'), ($2, 'role-removed')`,
        [first, second],
      )
      expect(await listener.flush()).toEqual([notification])

      await writer.query(`UPDATE platform.session_revocations SET "revokedBefore" = now() WHERE subject = ANY($1)`, [[first, second]])
      expect(await listener.flush()).toEqual([notification])

      // Nothing arrives before the commit and nothing after a rollback.
      await writer.query('BEGIN')
      await writer.query(`INSERT INTO platform.session_revocations (subject, reason) VALUES ($1, 'admin')`, [first])
      expect(await listener.flush()).toEqual([])
      await writer.query('COMMIT')
      expect(await listener.flush()).toEqual([notification])

      await writer.query('BEGIN')
      await writer.query('DELETE FROM platform.session_revocations WHERE subject = $1', [second])
      await writer.query('ROLLBACK')
      expect(await listener.flush()).toEqual([])

      await writer.query('DELETE FROM platform.session_revocations WHERE subject = $1', [second])
      expect(await listener.flush()).toEqual([notification])
    } finally {
      await writer.end()
      await listener.close()
    }

    const triggers = await superuser.query<{ definition: string }>(
      `SELECT pg_get_triggerdef(oid) AS definition
         FROM pg_trigger
        WHERE tgrelid = 'platform.session_revocations'::regclass AND NOT tgisinternal`,
    )
    expect(triggers.rows).toEqual([
      {
        definition:
          "CREATE TRIGGER bridge_notify AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON platform.session_revocations FOR EACH STATEMENT EXECUTE FUNCTION bridge.notify_change('revocations')",
      },
    ])
  })

  it('libredb_studio can read the view and not platform.session_revocations', async () => {
    const subject = newSubject()
    const revokedBefore = new Date()
    await insertRevocation(platform, { subject, reason: 'admin', revokedBefore })

    expect(await viewRows(studio, [subject])).toEqual([{ subject, revoked_before: revokedBefore }])

    // The revocation table stays Platform's: Studio reads the deny-only view and never writes a revocation.
    await expectSqlState(studio.query('SELECT id FROM platform.session_revocations LIMIT 1'), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(
      studio.query(`INSERT INTO platform.session_revocations (subject, reason) VALUES ($1, 'admin')`, [newSubject()]),
      INSUFFICIENT_PRIVILEGE,
    )
    await expectSqlState(
      studio.query(`UPDATE platform.session_revocations SET "revokedBefore" = now() - interval '1 day' WHERE subject = $1`, [subject]),
      INSUFFICIENT_PRIVILEGE,
    )
    await expectSqlState(studio.query('DELETE FROM platform.session_revocations WHERE subject = $1', [subject]), INSUFFICIENT_PRIVILEGE)
    // The view aggregates, so no role can write through it: PostgreSQL refuses that before it checks the privilege.
    await expectSqlState(
      studio.query('INSERT INTO "bridge".session_revocations_v1 (subject, revoked_before) VALUES ($1, now())', [newSubject()]),
      OBJECT_NOT_IN_PREREQUISITE_STATE,
    )
    await expectSqlState(studio.query('DELETE FROM "bridge".session_revocations_v1 WHERE subject = $1', [subject]), OBJECT_NOT_IN_PREREQUISITE_STATE)
    expect(await viewRows(studio, [subject])).toEqual([{ subject, revoked_before: revokedBefore }])
  })

  it('bridge.session_revocations_v1 has the columns of the contract, belongs to libredb_owner with the view options of the contract and grants SELECT to both runtime roles only', async () => {
    // The column names and types of the contract manifest, where timestamptz is PostgreSQL's timestamp with time zone.
    const columns = await superuser.query<{ name: string; type: string }>(
      `SELECT attname AS name, format_type(atttypid, NULL) AS type
         FROM pg_attribute
        WHERE attrelid = 'bridge.session_revocations_v1'::regclass AND attnum > 0 AND NOT attisdropped
        ORDER BY attnum`,
    )
    expect(columns.rows).toEqual([
      { name: 'subject', type: 'text' },
      { name: 'revoked_before', type: 'timestamp with time zone' },
    ])

    const view = await superuser.query<{ owner: string; options: string[]; grants: string[] }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner, c.reloptions AS options,
              ${GRANTS_OF("coalesce(c.relacl, acldefault('r', c.relowner))", 'c.relowner')} AS grants
         FROM pg_class c
        WHERE c.oid = 'bridge.session_revocations_v1'::regclass`,
    )
    expect(view.rows.map((row) => ({ ...row, options: [...row.options].sort() }))).toEqual([
      {
        owner: 'libredb_owner',
        options: ['security_barrier=true', 'security_invoker=false'],
        grants: ['libredb_platform:SELECT', 'libredb_studio:SELECT'],
      },
    ])

    // The runtime role has DML on the revocation table through the default privileges, which the break-glass INSERT needs.
    const table = await superuser.query<{ owner: string; grants: string[] }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner,
              ${GRANTS_OF("coalesce(c.relacl, acldefault('r', c.relowner))", 'c.relowner')} AS grants
         FROM pg_class c
        WHERE c.oid = 'platform.session_revocations'::regclass`,
    )
    expect(table.rows).toEqual([
      {
        owner: 'libredb_owner',
        grants: ['libredb_platform:DELETE', 'libredb_platform:INSERT', 'libredb_platform:SELECT', 'libredb_platform:UPDATE'],
      },
    ])

    // Studio looks a subject up by its latest revocation, and the admin who revoked is kept only as long as the user row.
    const indexes = await superuser.query<{ definition: string }>(
      `SELECT pg_get_indexdef(indexrelid) AS definition
         FROM pg_index
        WHERE indrelid = 'platform.session_revocations'::regclass AND NOT indisprimary`,
    )
    expect(indexes.rows).toEqual([
      {
        definition:
          'CREATE INDEX "session_revocations_subject_revokedBefore_idx" ON platform.session_revocations USING btree (subject, "revokedBefore" DESC)',
      },
    ])
    const keys = await superuser.query(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'platform.session_revocations'::regclass AND contype = 'f'`,
    )
    expect(keys.rows).toEqual([
      {
        name: 'session_revocations_createdById_fkey',
        definition: 'FOREIGN KEY ("createdById") REFERENCES platform.users(id) ON UPDATE CASCADE ON DELETE SET NULL',
      },
    ])
  })
})
