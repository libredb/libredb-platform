import { randomBytes, randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPlatform, connectStudio, connectSuperuser } from './connect'
import { listenBridge } from './listen'
import { expectSqlState } from './sqlstate'

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'
const WITH_CHECK_OPTION_VIOLATION = '44000'

const DAY_MS = 24 * 60 * 60 * 1000

// Every query event of this file has this subject and every heartbeat an instance id with this prefix, so the cleanup removes exactly them.
const SUBJECT = `bridge-base-${randomUUID()}`
const INSTANCE_PREFIX = `bridge-base-${randomUUID().slice(0, 8)}`

type QueryEvent = Record<string, unknown>

interface Heartbeat {
  instanceId: string
  studioVersion: string
  supportedContracts: number[]
  contractVersion: number
  keyringKids: string[]
  listenerState: string
  lastNotificationAt: Date | null
  snapshotLoadedAt: Date | null
  skipped: unknown[]
  sink: Record<string, unknown>
  canary: Record<string, string>
  startedAt: Date
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

// A successful SELECT with a redacted statement on a resolved connection, with the columns of Studio's insert.
function queryEvent(overrides: QueryEvent = {}): QueryEvent {
  const finishedAt = Date.now()
  return {
    event_id: randomUUID(),
    started_at: new Date(finishedAt - 42),
    finished_at: new Date(finishedAt),
    contract_version: 1,
    studio_instance: 'libredb-studio',
    subject: SUBJECT,
    username: 'alice@example.com',
    session_role: 'user',
    connection_id: randomUUID(),
    connection_name: 'Orders',
    engine: 'postgres',
    access_level: 'read',
    source: 'editor',
    statement_type: 'SELECT',
    explain: null,
    statement_capture: 'redacted',
    statement: 'SELECT id, total FROM orders WHERE customer_id = ? LIMIT ?',
    statement_truncated: false,
    statement_fingerprint: hex(32),
    unit_index: null,
    row_count: 12,
    duration_ms: 42,
    status: 'success',
    error_code: null,
    error_message: null,
    correlation_id: null,
    transaction_id: null,
    transaction_outcome: null,
    client_ip: '203.0.113.10',
    ...overrides,
  }
}

function startedAgo(ms: number): QueryEvent {
  const startedAt = Date.now() - ms
  return { started_at: new Date(startedAt), finished_at: new Date(startedAt + 42) }
}

// Inserts one event through bridge.query_events_v1 with ON CONFLICT DO NOTHING, as Studio's sink does,
// and returns the number of rows inserted.
async function insertEvent(client: Client, event: QueryEvent): Promise<number> {
  const columns = Object.keys(event)
  const result = await client.query(
    `INSERT INTO "bridge".query_events_v1 (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})
     ON CONFLICT DO NOTHING`,
    columns.map((column) => event[column]),
  )
  return result.rowCount ?? 0
}

// Studio's heartbeat: the first beat writes started_at, and every beat ends with
// ON CONFLICT (instance_id) DO UPDATE SET each reported column plus last_seen_at = now(), never started_at.
const HEARTBEAT_UPSERT = `INSERT INTO "bridge".studio_instances_v1 (instance_id, studio_version, supported_contracts, contract_version, keyring_kids, listener_state, last_notification_at, snapshot_loaded_at, skipped, sink, canary, started_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (instance_id) DO UPDATE SET studio_version = EXCLUDED.studio_version, supported_contracts = EXCLUDED.supported_contracts, contract_version = EXCLUDED.contract_version, keyring_kids = EXCLUDED.keyring_kids, listener_state = EXCLUDED.listener_state, last_notification_at = EXCLUDED.last_notification_at, snapshot_loaded_at = EXCLUDED.snapshot_loaded_at, skipped = EXCLUDED.skipped, sink = EXCLUDED.sink, canary = EXCLUDED.canary, last_seen_at = now()`

function heartbeat(overrides: Partial<Heartbeat> = {}): Heartbeat {
  const kid = hex(8)
  return {
    instanceId: `${INSTANCE_PREFIX}-${hex(4)}`,
    studioVersion: '1.0.0',
    supportedContracts: [1],
    contractVersion: 1,
    keyringKids: [kid],
    listenerState: 'listening',
    lastNotificationAt: null,
    snapshotLoadedAt: new Date(),
    skipped: [],
    sink: { queued: 0, dropped: 0, rejected: 0, lastFlushAt: null, backingOff: false, lastSqlstate: null },
    canary: { [kid]: 'ok' },
    startedAt: new Date(Date.now() - 60_000),
    ...overrides,
  }
}

async function beat(client: Client, report: Heartbeat): Promise<void> {
  await client.query(HEARTBEAT_UPSERT, [
    report.instanceId,
    report.studioVersion,
    report.supportedContracts,
    report.contractVersion,
    report.keyringKids,
    report.listenerState,
    report.lastNotificationAt,
    report.snapshotLoadedAt,
    JSON.stringify(report.skipped),
    JSON.stringify(report.sink),
    JSON.stringify(report.canary),
    report.startedAt,
  ])
}

async function readInstance(client: Client, instanceId: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    `SELECT instance_id, studio_version, supported_contracts, contract_version, keyring_kids, listener_state,
            last_notification_at, snapshot_loaded_at, skipped, sink, canary, started_at, last_seen_at
       FROM "bridge".studio_instances_v1
      WHERE instance_id = $1`,
    [instanceId],
  )
  expect(result.rows).toHaveLength(1)
  return result.rows[0]
}

function sealCanary(): { kid: string; envelope: string } {
  const kid = hex(8)
  return { kid, envelope: `lsb1.${kid}.${randomBytes(32).toString('base64url')}.${randomBytes(40).toString('base64url')}` }
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
describe('bridge base objects: contract, query events, heartbeat, seal canary and retention', () => {
  let superuser: Client
  let platform: Client
  let studio: Client
  const canaryKids: string[] = []

  beforeAll(async () => {
    superuser = await connectSuperuser()
    platform = await connectPlatform()
    studio = await connectStudio()
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM bridge.query_event WHERE subject = $1', [SUBJECT])
    await superuser.query('DELETE FROM bridge.studio_instance WHERE starts_with(instance_id, $1)', [INSTANCE_PREFIX])
    await superuser.query('DELETE FROM platform.seal_canary WHERE kid = ANY($1)', [canaryKids])
    await studio.end()
    await platform.end()
    await superuser.end()
  })

  it('libredb_studio inserts an event through bridge.query_events_v1, and a retry with the same event_id and ON CONFLICT DO NOTHING succeeds', async () => {
    const event = queryEvent()
    expect(await insertEvent(studio, event)).toBe(1)
    expect(await insertEvent(studio, event)).toBe(0)

    const stored = await platform.query(
      `SELECT event_id, contract_version, subject, source, status, statement, received_at
         FROM bridge.query_event
        WHERE event_id = $1`,
      [event.event_id],
    )
    expect(stored.rows).toEqual([
      {
        event_id: event.event_id,
        contract_version: 1,
        subject: SUBJECT,
        source: 'editor',
        status: 'success',
        statement: event.statement,
        received_at: expect.any(Date),
      },
    ])
  })

  it('libredb_studio cannot SELECT, UPDATE or DELETE bridge.query_event (42501)', async () => {
    const event = queryEvent()
    expect(await insertEvent(studio, event)).toBe(1)

    for (const relation of ['bridge.query_event', 'bridge.query_events_v1']) {
      await expectSqlState(studio.query(`SELECT event_id FROM ${relation} WHERE event_id = $1`, [event.event_id]), INSUFFICIENT_PRIVILEGE)
      await expectSqlState(
        studio.query(`UPDATE ${relation} SET status = 'error' WHERE event_id = $1`, [event.event_id]),
        INSUFFICIENT_PRIVILEGE,
      )
      await expectSqlState(studio.query(`DELETE FROM ${relation} WHERE event_id = $1`, [event.event_id]), INSUFFICIENT_PRIVILEGE)
    }
    await expectSqlState(studio.query('TRUNCATE bridge.query_event'), INSUFFICIENT_PRIVILEGE)

    const stored = await platform.query('SELECT status FROM bridge.query_event WHERE event_id = $1', [event.event_id])
    expect(stored.rows).toEqual([{ status: 'success' }])
  })

  it('the view refuses contract_version 2 through its check option', async () => {
    await expectSqlState(insertEvent(studio, queryEvent({ contract_version: 2 })), WITH_CHECK_OPTION_VIOLATION)

    // Without the column, the view's default writes version 1.
    const event = queryEvent()
    delete event.contract_version
    expect(await insertEvent(studio, event)).toBe(1)
    const stored = await platform.query('SELECT contract_version FROM bridge.query_event WHERE event_id = $1', [event.event_id])
    expect(stored.rows).toEqual([{ contract_version: 1 }])
  })

  it('capture none with a statement, error text without full capture, and a started_at 10 minutes ahead are refused (23514)', async () => {
    await expectCheckViolation(
      insertEvent(studio, queryEvent({ statement_capture: 'none', statement: 'SELECT 1', statement_fingerprint: null })),
      'query_event_capture_none',
    )
    await expectCheckViolation(
      insertEvent(studio, queryEvent({ statement_capture: 'none', statement: null })),
      'query_event_capture_none',
    )
    await expectCheckViolation(
      insertEvent(
        studio,
        queryEvent({ status: 'error', error_code: '42P01', error_message: 'relation "orders" does not exist' }),
      ),
      'query_event_error_text_full_only',
    )
    const ahead = Date.now() + 10 * 60_000
    await expectCheckViolation(
      insertEvent(studio, queryEvent({ started_at: new Date(ahead), finished_at: new Date(ahead + 42) })),
      'query_event_not_future',
    )

    // The same events pass once they follow the rules.
    expect(
      await insertEvent(studio, queryEvent({ statement_capture: 'none', statement: null, statement_fingerprint: null })),
    ).toBe(1)
    expect(
      await insertEvent(
        studio,
        queryEvent({
          statement_capture: 'full',
          statement: 'SELECT id, total FROM orders WHERE customer_id = 7',
          status: 'error',
          error_code: '42P01',
          error_message: 'relation "orders" does not exist',
        }),
      ),
    ).toBe(1)
    const soon = Date.now() + 4 * 60_000
    expect(await insertEvent(studio, queryEvent({ started_at: new Date(soon), finished_at: new Date(soon + 42) }))).toBe(1)
  })

  it('an unknown source such as agent-handover is accepted and an unknown status is refused', async () => {
    expect(await insertEvent(studio, queryEvent({ source: 'agent-handover' }))).toBe(1)
    expect(
      await insertEvent(
        studio,
        queryEvent({ source: 'transaction', transaction_id: 'tx-1', transaction_outcome: 'handed-over' }),
      ),
    ).toBe(1)

    await expectCheckViolation(insertEvent(studio, queryEvent({ status: 'timeout' })), 'query_event_status_check')
    // The open vocabularies are still checked by format.
    await expectCheckViolation(insertEvent(studio, queryEvent({ source: 'Agent_Handover' })), 'query_event_source_check')
  })

  it('libredb_studio upserts its heartbeat through bridge.studio_instances_v1 with ON CONFLICT (instance_id)', async () => {
    const first = heartbeat()
    await beat(studio, first)

    expect(await readInstance(studio, first.instanceId)).toEqual({
      instance_id: first.instanceId,
      studio_version: '1.0.0',
      supported_contracts: [1],
      contract_version: 1,
      keyring_kids: first.keyringKids,
      listener_state: 'listening',
      last_notification_at: null,
      snapshot_loaded_at: first.snapshotLoadedAt,
      skipped: [],
      sink: first.sink,
      canary: first.canary,
      started_at: first.startedAt,
      last_seen_at: expect.any(Date),
    })
  })

  it('a second heartbeat upsert by libredb_studio advances last_seen_at and keeps started_at', async () => {
    const first = heartbeat()
    await beat(studio, first)
    const before = await readInstance(studio, first.instanceId)

    await new Promise((resolve) => setTimeout(resolve, 20))
    const newKid = hex(8)
    const second: Heartbeat = {
      ...first,
      studioVersion: '1.0.1',
      keyringKids: [...first.keyringKids, newKid],
      listenerState: 'polling',
      lastNotificationAt: new Date(),
      snapshotLoadedAt: new Date(),
      skipped: [{ kind: 'setting', id: 'query.timeoutMs', code: 'SETTING_INVALID' }],
      canary: { ...first.canary, [newKid]: 'UNKNOWN_KID' },
      // A beat that reports another start time must not move started_at.
      startedAt: new Date(),
    }
    await beat(studio, second)
    const after = await readInstance(studio, first.instanceId)

    expect(after).toEqual({
      instance_id: first.instanceId,
      studio_version: '1.0.1',
      supported_contracts: [1],
      contract_version: 1,
      keyring_kids: second.keyringKids,
      listener_state: 'polling',
      last_notification_at: second.lastNotificationAt,
      snapshot_loaded_at: second.snapshotLoadedAt,
      skipped: second.skipped,
      sink: first.sink,
      canary: second.canary,
      started_at: first.startedAt,
      last_seen_at: expect.any(Date),
    })
    expect((after.last_seen_at as Date).getTime()).toBeGreaterThan((before.last_seen_at as Date).getTime())
  })

  it('a heartbeat listing 17 keyring kids is refused (23514)', async () => {
    const kids = Array.from({ length: 17 }, () => hex(8))
    await expectCheckViolation(beat(studio, heartbeat({ keyringKids: kids })), 'studio_instance_keyring_kids_check')

    // Sixteen, the keyring's limit, pass.
    const sixteen = heartbeat({ keyringKids: kids.slice(0, 16) })
    await beat(studio, sixteen)
    expect((await readInstance(studio, sixteen.instanceId)).keyring_kids).toEqual(kids.slice(0, 16))
  })

  it('libredb_platform reads bridge.query_event and deletes from bridge.studio_instance, and cannot delete query events (42501)', async () => {
    const event = queryEvent()
    expect(await insertEvent(studio, event)).toBe(1)
    const instance = heartbeat()
    await beat(studio, instance)

    const events = await platform.query('SELECT event_id, subject FROM bridge.query_event WHERE event_id = $1', [event.event_id])
    expect(events.rows).toEqual([{ event_id: event.event_id, subject: SUBJECT }])

    const instances = await platform.query('SELECT instance_id FROM bridge.studio_instance WHERE instance_id = $1', [
      instance.instanceId,
    ])
    expect(instances.rows).toEqual([{ instance_id: instance.instanceId }])
    const deleted = await platform.query('DELETE FROM bridge.studio_instance WHERE instance_id = $1', [instance.instanceId])
    expect(deleted.rowCount).toBe(1)

    await expectSqlState(platform.query('DELETE FROM bridge.query_event WHERE event_id = $1', [event.event_id]), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(
      platform.query(`UPDATE bridge.query_event SET status = 'error' WHERE event_id = $1`, [event.event_id]),
      INSUFFICIENT_PRIVILEGE,
    )
    await expectSqlState(platform.query('TRUNCATE bridge.query_event'), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(insertEvent(platform, queryEvent()), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(
      platform.query(`UPDATE bridge.studio_instance SET listener_state = 'deaf' WHERE instance_id = $1`, [instance.instanceId]),
      INSUFFICIENT_PRIVILEGE,
    )

    const kept = await platform.query('SELECT event_id FROM bridge.query_event WHERE event_id = $1', [event.event_id])
    expect(kept.rows).toEqual([{ event_id: event.event_id }])
  })

  it('trim_query_events(1, 1000) deletes nothing younger than 7 days, and trim_query_events(90, 2) deletes older rows two at a time', async () => {
    const young = [queryEvent(startedAgo(DAY_MS)), queryEvent(startedAgo(7 * DAY_MS - 60 * 60_000))]
    const weekOld = queryEvent(startedAgo(8 * DAY_MS))
    // Older than any other row, so the oldest-first order of the deletes is observable.
    const ancient = Array.from({ length: 5 }, (_, index) => {
      const startedAt = Date.UTC(2001, 0, 1 + index)
      return queryEvent({ started_at: new Date(startedAt), finished_at: new Date(startedAt + 42) })
    })
    for (const event of [...young, weekOld, ...ancient]) {
      expect(await insertEvent(studio, event)).toBe(1)
    }
    const ids = (events: QueryEvent[]) => events.map((event) => event.event_id as string)

    // Each part runs in a transaction that rolls back, so rows of other test files stay untouched.
    const trimmer = await connectPlatform()
    const remainingOf = async (events: QueryEvent[]) => {
      const result = await trimmer.query<{ event_id: string }>(
        'SELECT event_id FROM bridge.query_event WHERE event_id = ANY($1) ORDER BY started_at',
        [ids(events)],
      )
      return result.rows.map((row) => row.event_id)
    }
    const countWhere = async (condition: string) => {
      const result = await trimmer.query<{ count: number }>(`SELECT count(*)::int AS count FROM bridge.query_event WHERE ${condition}`)
      return result.rows[0].count
    }
    const trim = async (days: number, batch: number) => {
      const result = await trimmer.query<{ deleted: number }>('SELECT bridge.trim_query_events($1, $2)::int AS deleted', [days, batch])
      return result.rows[0].deleted
    }

    try {
      await trimmer.query('BEGIN')
      const olderThanFloor = await countWhere(`started_at < now() - interval '7 days'`)
      const youngerThanFloor = await countWhere(`started_at >= now() - interval '7 days'`)
      expect(await trim(1, 1000)).toBe(Math.min(olderThanFloor, 1000))
      expect(await countWhere(`started_at >= now() - interval '7 days'`)).toBe(youngerThanFloor)
      expect(await remainingOf([...young, weekOld, ...ancient])).toEqual(ids([young[1], young[0]]))
      await trimmer.query('ROLLBACK')

      await trimmer.query('BEGIN')
      const oldest = await trimmer.query<{ event_id: string }>('SELECT event_id FROM bridge.query_event ORDER BY started_at LIMIT 1')
      expect(oldest.rows).toEqual([{ event_id: ancient[0].event_id }])
      let expired = await countWhere(`started_at < now() - interval '90 days'`)
      expect(expired).toBeGreaterThanOrEqual(ancient.length)

      expect(await trim(90, 2)).toBe(2)
      expect(await remainingOf(ancient)).toEqual(ids(ancient.slice(2)))
      expired -= 2
      while (expired > 0) {
        const deleted = await trim(90, 2)
        expect(deleted).toBe(Math.min(2, expired))
        expired -= deleted
        expect(await countWhere(`started_at < now() - interval '90 days'`)).toBe(expired)
      }
      expect(await trim(90, 2)).toBe(0)
      expect(await remainingOf([...young, weekOld, ...ancient])).toEqual(ids([weekOld, young[1], young[0]]))
      await trimmer.query('ROLLBACK')
    } finally {
      await trimmer.end()
    }
  })

  it('libredb_studio cannot execute trim_query_events, and neither runtime role can create objects in bridge (42501)', async () => {
    await expectSqlState(studio.query('SELECT bridge.trim_query_events(90, 10)'), INSUFFICIENT_PRIVILEGE)

    for (const client of [platform, studio]) {
      const name = `probe_${hex(6)}`
      await expectSqlState(client.query(`CREATE TABLE bridge.${name} (id integer)`), INSUFFICIENT_PRIVILEGE)
      await expectSqlState(client.query(`CREATE VIEW bridge.${name} AS SELECT 1 AS id`), INSUFFICIENT_PRIVILEGE)
      await expectSqlState(
        client.query(`CREATE FUNCTION bridge.${name}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`),
        INSUFFICIENT_PRIVILEGE,
      )
    }
  })

  it('an insert into platform.seal_canary sends the canary notification on libredb_bridge after commit and none on rollback', async () => {
    const listener = await listenBridge()
    const writer = await connectPlatform()
    try {
      const committed = sealCanary()
      canaryKids.push(committed.kid)
      await writer.query('BEGIN')
      await writer.query('INSERT INTO platform.seal_canary (kid, envelope) VALUES ($1, $2)', [committed.kid, committed.envelope])
      expect(await listener.flush()).toEqual([])
      await writer.query('COMMIT')
      expect(await listener.flush()).toEqual([{ v: 1, kind: 'canary' }])

      const rolledBack = sealCanary()
      await writer.query('BEGIN')
      await writer.query('INSERT INTO platform.seal_canary (kid, envelope) VALUES ($1, $2)', [rolledBack.kid, rolledBack.envelope])
      await writer.query('ROLLBACK')
      expect(await listener.flush()).toEqual([])
    } finally {
      await writer.end()
      await listener.close()
    }
  })

  it('bridge.contract lists version 1 in its final shape', async () => {
    // Published by the migration publish_contract_v1 once every v1 object exists.
    for (const client of [studio, platform]) {
      const contract = await client.query('SELECT version, status, sunset_after, notify_channel FROM "bridge".contract')
      expect(contract.rows).toEqual([{ version: 1, status: 'current', sunset_after: null, notify_channel: 'libredb_bridge' }])
    }

    // The final shape, which never changes.
    const columns = await superuser.query<{ name: string; type: string }>(
      `SELECT attname AS name, format_type(atttypid, atttypmod) AS type
         FROM pg_attribute
        WHERE attrelid = 'bridge.contract'::regclass AND attnum > 0 AND NOT attisdropped
        ORDER BY attnum`,
    )
    expect(columns.rows).toEqual([
      { name: 'version', type: 'smallint' },
      { name: 'status', type: 'text' },
      { name: 'sunset_after', type: 'timestamp with time zone' },
      { name: 'notify_channel', type: 'text' },
    ])
  })

  it('bridge.seal_canary_v1 shows kid, envelope and created_at to both runtime roles, and libredb_studio cannot read platform.seal_canary (42501)', async () => {
    const canary = sealCanary()
    canaryKids.push(canary.kid)
    await platform.query('INSERT INTO platform.seal_canary (kid, envelope) VALUES ($1, $2)', [canary.kid, canary.envelope])

    for (const client of [studio, platform]) {
      const view = await client.query('SELECT kid, envelope, created_at FROM "bridge".seal_canary_v1 WHERE kid = $1', [canary.kid])
      expect(view.rows).toEqual([{ kid: canary.kid, envelope: canary.envelope, created_at: expect.any(Date) }])
    }
    await expectSqlState(studio.query('SELECT kid FROM platform.seal_canary'), INSUFFICIENT_PRIVILEGE)
  })

  it('platform.seal_canary refuses a kid that is not 16 lowercase hex digits and an envelope without the lsb prefix (23514)', async () => {
    const canary = sealCanary()
    const insert = (kid: string, envelope: string) =>
      platform.query('INSERT INTO platform.seal_canary (kid, envelope) VALUES ($1, $2)', [kid, envelope])

    await expectCheckViolation(insert('0123456789ABCDEF', canary.envelope), 'seal_canary_kid_check')
    await expectCheckViolation(insert(canary.kid.slice(1), canary.envelope), 'seal_canary_kid_check')
    await expectCheckViolation(insert(canary.kid, canary.envelope.replace(/^lsb1\./, 'lsb0.')), 'seal_canary_envelope_check')
    await expectCheckViolation(insert(canary.kid, `${hex(12)}:${hex(16)}:${hex(24)}`), 'seal_canary_envelope_check')
  })

  it('platform.seal_canary has the statement-level bridge_notify trigger of kind canary for every kind of change', async () => {
    const triggers = await superuser.query<{ definition: string }>(
      `SELECT pg_get_triggerdef(oid) AS definition
         FROM pg_trigger
        WHERE tgrelid = 'platform.seal_canary'::regclass AND NOT tgisinternal`,
    )
    expect(triggers.rows).toEqual([
      {
        definition:
          "CREATE TRIGGER bridge_notify AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON platform.seal_canary FOR EACH STATEMENT EXECUTE FUNCTION bridge.notify_change('canary')",
      },
    ])
  })

  it('bridge.query_event has the indexes for retention and the audit reader', async () => {
    const indexes = await superuser.query<{ name: string; definition: string }>(
      `SELECT indexname AS name, indexdef AS definition
         FROM pg_indexes
        WHERE schemaname = 'bridge' AND tablename = 'query_event'
        ORDER BY indexname COLLATE "C"`,
    )
    expect(indexes.rows).toEqual([
      {
        name: 'query_event_connection_idx',
        definition: 'CREATE INDEX query_event_connection_idx ON bridge.query_event USING btree (connection_id, started_at)',
      },
      { name: 'query_event_pkey', definition: 'CREATE UNIQUE INDEX query_event_pkey ON bridge.query_event USING btree (event_id)' },
      {
        name: 'query_event_started_at_idx',
        definition: 'CREATE INDEX query_event_started_at_idx ON bridge.query_event USING btree (started_at)',
      },
      {
        name: 'query_event_subject_idx',
        definition: 'CREATE INDEX query_event_subject_idx ON bridge.query_event USING btree (subject, started_at)',
      },
    ])
  })

  it('schema bridge and its objects belong to libredb_owner, with the view options and grants of the contract and nothing for PUBLIC', async () => {
    const schema = await superuser.query(
      `SELECT pg_get_userbyid(n.nspowner) AS owner, ${GRANTS_OF("coalesce(n.nspacl, acldefault('n', n.nspowner))", 'n.nspowner')} AS grants
         FROM pg_namespace n
        WHERE n.nspname = 'bridge'`,
    )
    expect(schema.rows).toEqual([{ owner: 'libredb_owner', grants: ['libredb_platform:USAGE', 'libredb_studio:USAGE'] }])

    const relations = await superuser.query<{ name: string; owner: string; options: string[] | null; grants: string[] }>(
      `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner, c.reloptions AS options,
              ${GRANTS_OF("coalesce(c.relacl, acldefault('r', c.relowner))", 'c.relowner')} AS grants
         FROM pg_class c
        WHERE c.relnamespace = 'bridge'::regnamespace
          AND c.relname IN ('contract', 'seal_canary_v1', 'query_event', 'query_events_v1', 'studio_instance', 'studio_instances_v1')
        ORDER BY c.relname COLLATE "C"`,
    )
    const view = ['security_barrier=true', 'security_invoker=false']
    expect(
      relations.rows.map((row) => ({ ...row, options: row.options === null ? null : [...row.options].sort() })),
    ).toEqual([
      { name: 'contract', owner: 'libredb_owner', options: view, grants: ['libredb_platform:SELECT', 'libredb_studio:SELECT'] },
      { name: 'query_event', owner: 'libredb_owner', options: null, grants: ['libredb_platform:SELECT'] },
      {
        name: 'query_events_v1',
        owner: 'libredb_owner',
        options: ['check_option=local', ...view],
        grants: ['libredb_studio:INSERT'],
      },
      { name: 'seal_canary_v1', owner: 'libredb_owner', options: view, grants: ['libredb_platform:SELECT', 'libredb_studio:SELECT'] },
      { name: 'studio_instance', owner: 'libredb_owner', options: null, grants: ['libredb_platform:DELETE', 'libredb_platform:SELECT'] },
      {
        name: 'studio_instances_v1',
        owner: 'libredb_owner',
        options: view,
        grants: ['libredb_studio:INSERT', 'libredb_studio:SELECT', 'libredb_studio:UPDATE'],
      },
    ])

    const functions = await superuser.query(
      `SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
              ${GRANTS_OF("coalesce(p.proacl, acldefault('f', p.proowner))", 'p.proowner')} AS grants
         FROM pg_proc p
        WHERE p.pronamespace = 'bridge'::regnamespace
          AND p.proname IN ('notify_change', 'trim_query_events')
        ORDER BY p.proname COLLATE "C"`,
    )
    expect(functions.rows).toEqual([
      { signature: 'bridge.notify_change()', owner: 'libredb_owner', security_definer: false, grants: [] },
      {
        signature: 'bridge.trim_query_events(integer,integer)',
        owner: 'libredb_owner',
        security_definer: true,
        grants: ['libredb_platform:EXECUTE'],
      },
    ])

    // No object in schema bridge grants anything to PUBLIC.
    const toPublic = await superuser.query(
      `SELECT c.relname AS name
         FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        WHERE c.relnamespace = 'bridge'::regnamespace AND a.grantee = 0
       UNION ALL
       SELECT p.proname
         FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.pronamespace = 'bridge'::regnamespace AND a.grantee = 0`,
    )
    expect(toPublic.rows).toEqual([])
  })
})
