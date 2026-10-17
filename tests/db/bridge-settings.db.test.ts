import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import path from 'path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allowlistSql } from '../../scripts/generate-studio-settings-allowlist.mjs'
import { connectOwner, connectPlatform, connectStudio, connectSuperuser } from './connect'
import { listenBridge } from './listen'
import { expectSqlState } from './sqlstate'

const INSUFFICIENT_PRIVILEGE = '42501'
const FOREIGN_KEY_VIOLATION = '23503'
const INVALID_PARAMETER_VALUE = '22023'
const CHECK_VIOLATION = '23514'

const CONTRACT = path.join(__dirname, '..', 'fixtures', 'governance', 'contract-v1.json')

interface RegistryEntry {
  key: string
  type: string
  allowedValues: unknown[] | null
  min: number | null
  max: number | null
  sinceContract: number
  description: string
}

const registry = (): RegistryEntry[] => JSON.parse(readFileSync(CONTRACT, 'utf8')).settings

// A key no Studio publishes, so a test can add it to the allowlist and remove it again.
function probeKey(): string {
  return `probe.k${randomBytes(6).toString('hex')}`
}

const KEY_COLUMNS = 'key, "valueType", "allowedValues", "minValue", "maxValue", "sinceContract", description'

// The allowlist rows in the shape of the registry entries of contract-v1.json, ordered by key.
async function allowlist(client: Client): Promise<RegistryEntry[]> {
  const result = await client.query(`SELECT ${KEY_COLUMNS} FROM platform.studio_setting_keys ORDER BY key COLLATE "C"`)
  return result.rows.map((row) => ({
    key: row.key,
    type: row.valueType,
    allowedValues: row.allowedValues,
    min: row.minValue === null ? null : Number(row.minValue),
    max: row.maxValue === null ? null : Number(row.maxValue),
    sinceContract: row.sinceContract,
    description: row.description,
  }))
}

async function setSetting(client: Client, key: string, value: unknown, updatedBy: string = 'system:seed'): Promise<void> {
  await client.query(
    `INSERT INTO platform.studio_settings (key, value, "updatedBy") VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedBy" = EXCLUDED."updatedBy"`,
    [key, JSON.stringify(value), updatedBy],
  )
}

// Asserts that the operation fails with SQLSTATE 23514 raised by the named CHECK constraint.
async function expectCheckViolation(operation: Promise<unknown>, constraint: string): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error, `expected the CHECK constraint ${constraint} to refuse the row`).toMatchObject({ code: CHECK_VIOLATION, constraint })
}

// Applied by tests/db/global-setup.ts, which runs `prisma migrate deploy` as libredb_owner.
describe('platform.studio_setting_keys, platform.studio_settings and bridge.settings_v1', () => {
  let superuser: Client
  let owner: Client
  let platform: Client
  let studio: Client

  beforeAll(async () => {
    superuser = await connectSuperuser()
    owner = await connectOwner()
    platform = await connectPlatform()
    studio = await connectStudio()
  })

  afterAll(async () => {
    await platform?.query('DELETE FROM platform.studio_settings')
    await Promise.all([superuser, owner, platform, studio].map((client) => client?.end()))
  })

  it('libredb_platform cannot insert, update or delete allowlist rows (42501)', async () => {
    const key = probeKey()
    await expectSqlState(
      platform.query(`INSERT INTO platform.studio_setting_keys (key, "valueType", description) VALUES ($1, 'boolean', 'Probe')`, [key]),
      INSUFFICIENT_PRIVILEGE,
    )
    await expectSqlState(
      platform.query(`UPDATE platform.studio_setting_keys SET "maxValue" = 7200000 WHERE key = 'query.timeoutMs'`),
      INSUFFICIENT_PRIVILEGE,
    )
    await expectSqlState(platform.query(`DELETE FROM platform.studio_setting_keys WHERE key = 'ai.enabled'`), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(platform.query('TRUNCATE platform.studio_setting_keys CASCADE'), INSUFFICIENT_PRIVILEGE)

    // It reads the allowlist, which the settings page renders, and writes the values.
    const keys = await platform.query('SELECT key FROM platform.studio_setting_keys')
    expect(keys.rows.length).toBe(registry().length)
    const privileges = await platform.query<{ privilege: string; granted: boolean }>(
      `SELECT privilege, has_table_privilege('platform.studio_settings', privilege) AS granted
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS privilege`,
    )
    expect(privileges.rows.filter((row) => !row.granted)).toEqual([])

    // Studio reads the values only through bridge.settings_v1.
    await expectSqlState(studio.query('SELECT key FROM platform.studio_setting_keys'), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(studio.query('SELECT key FROM platform.studio_settings'), INSUFFICIENT_PRIVILEGE)
  })

  it('the trigger refuses a key outside the allowlist, a wrong JSON type, an out-of-range value and a value outside the allowed set', async () => {
    await platform.query('BEGIN')
    try {
      for (const [key, value, sqlState] of [
        ['probe.unknownKey', true, FOREIGN_KEY_VIOLATION],
        ['ai.enabled', 'true', INVALID_PARAMETER_VALUE],
        ['ai.enabled', 1, INVALID_PARAMETER_VALUE],
        ['query.timeoutMs', '60000', INVALID_PARAMETER_VALUE],
        ['query.timeoutMs', 999, INVALID_PARAMETER_VALUE],
        ['query.timeoutMs', 3600001, INVALID_PARAMETER_VALUE],
        ['query.timeoutMs', 1500.5, INVALID_PARAMETER_VALUE],
        ['provider.poolMaxPerUser', 0, INVALID_PARAMETER_VALUE],
        ['queryLog.statementCapture', 'partial', INVALID_PARAMETER_VALUE],
        ['queryLog.statementCapture', ['full'], INVALID_PARAMETER_VALUE],
        ['queryLog.onSinkFailure', null, INVALID_PARAMETER_VALUE],
      ] as const) {
        await platform.query('SAVEPOINT probe')
        await expectSqlState(setSetting(platform, key, value), sqlState)
        await platform.query('ROLLBACK TO SAVEPOINT probe')
      }

      // The bounds and the allowed set are inclusive, and an update is checked as an insert is.
      for (const [key, value] of [
        ['ai.enabled', false],
        ['query.timeoutMs', 1000],
        ['query.timeoutMs', 3600000],
        ['provider.poolMaxPerUser', 10],
        ['queryLog.statementCapture', 'redacted'],
        ['queryLog.onSinkFailure', 'refuse'],
      ] as const) {
        await setSetting(platform, key, value, 'user-1')
      }
      await expectSqlState(
        platform.query(`UPDATE platform.studio_settings SET value = '"partial"' WHERE key = 'queryLog.statementCapture'`),
        INVALID_PARAMETER_VALUE,
      )
    } finally {
      await platform.query('ROLLBACK')
    }
  })

  it('the trigger stamps updatedAt on every write', async () => {
    const before = new Date(Date.now() - 60_000)
    await platform.query('BEGIN')
    try {
      await platform.query(
        `INSERT INTO platform.studio_settings (key, value, "updatedAt", "updatedBy") VALUES ('ai.enabled', 'false', $1, 'user-1')`,
        [before],
      )
      // updatedAt is timestamptz(3), so PostgreSQL rounds now() to the millisecond, while a JS Date of now() truncates
      // it; the comparison therefore happens in SQL at the column's precision.
      const stamped = await platform.query<{ updatedAt: string; now: string }>(
        `SELECT "updatedAt"::text AS "updatedAt", now()::timestamptz(3)::text AS now
           FROM platform.studio_settings WHERE key = 'ai.enabled'`,
      )
      expect(stamped.rows[0].updatedAt).toBe(stamped.rows[0].now)
    } finally {
      await platform.query('ROLLBACK')
    }
  })

  it('the allowlist refuses a malformed key, an unknown value type and allowed values that are not an array (23514)', async () => {
    await owner.query('BEGIN')
    try {
      for (const [values, constraint] of [
        [['Probe.key', 'boolean', null], 'studio_setting_keys_key_check'],
        [['probe', 'boolean', null], 'studio_setting_keys_key_check'],
        [[probeKey(), 'number', null], 'studio_setting_keys_valueType_check'],
        [[probeKey(), 'string', '"none"'], 'studio_setting_keys_allowedValues_check'],
      ] as const) {
        await owner.query('SAVEPOINT probe')
        await expectCheckViolation(
          owner.query(`INSERT INTO platform.studio_setting_keys (key, "valueType", "allowedValues", description) VALUES ($1, $2, $3, 'Probe')`, [
            ...values,
          ]),
          constraint,
        )
        await owner.query('ROLLBACK TO SAVEPOINT probe')
      }
    } finally {
      await owner.query('ROLLBACK')
    }
  })

  it('bridge.settings_v1 exposes only allowlisted keys with since_contract 1 or lower', async () => {
    const future = probeKey()
    await owner.query(
      `INSERT INTO platform.studio_setting_keys (key, "valueType", "sinceContract", description) VALUES ($1, 'boolean', 2, 'A key of contract 2')`,
      [future],
    )
    try {
      await setSetting(platform, future, true)
      await setSetting(platform, 'query.timeoutMs', 120000, 'user-1')
      await setSetting(platform, 'queryLog.statementCapture', 'redacted')
      const stored = await platform.query<{ key: string; updatedAt: Date }>(
        `SELECT key, "updatedAt" FROM platform.studio_settings WHERE key IN ('query.timeoutMs', 'queryLog.statementCapture')`,
      )
      const updatedAt = Object.fromEntries(stored.rows.map((row) => [row.key, row.updatedAt]))

      for (const reader of [studio, platform]) {
        const rows = await reader.query('SELECT * FROM "bridge".settings_v1 ORDER BY key COLLATE "C"')
        expect(rows.fields.map((field) => field.name)).toEqual(['key', 'value', 'updated_at'])
        expect(rows.rows).toEqual([
          { key: 'query.timeoutMs', value: 120000, updated_at: updatedAt['query.timeoutMs'] },
          { key: 'queryLog.statementCapture', value: 'redacted', updated_at: updatedAt['queryLog.statementCapture'] },
        ])
      }

      // Removing a key from the allowlist removes its value with it.
      await owner.query('DELETE FROM platform.studio_setting_keys WHERE key = $1', [future])
      const removed = await platform.query('SELECT key FROM platform.studio_settings WHERE key = $1', [future])
      expect(removed.rows).toEqual([])
    } finally {
      await owner.query('DELETE FROM platform.studio_setting_keys WHERE key = $1', [future])
      await platform.query('DELETE FROM platform.studio_settings')
    }

    const view = await superuser.query<{ owner: string; options: string[] | null; grants: string[] }>(
      `SELECT pg_get_userbyid(c.relowner) AS owner, c.reloptions AS options,
              (SELECT array_agg(pg_get_userbyid(a.grantee) || ':' || a.privilege_type
                                  ORDER BY pg_get_userbyid(a.grantee) || ':' || a.privilege_type COLLATE "C")
                 FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner) AS grants
         FROM pg_class c WHERE c.oid = 'bridge.settings_v1'::regclass`,
    )
    expect(view.rows).toEqual([
      {
        owner: 'libredb_owner',
        options: ['security_barrier=true', 'security_invoker=false'],
        grants: ['libredb_platform:SELECT', 'libredb_studio:SELECT'],
      },
    ])
  })

  it('one notification of kind settings arrives per committed statement', async () => {
    const listener = await listenBridge()
    const writer = await connectPlatform()
    const notification = { v: 1, kind: 'settings' }
    const key = probeKey()
    try {
      await writer.query(
        `INSERT INTO platform.studio_settings (key, value, "updatedBy") VALUES ('ai.enabled', 'false', 'user-1'), ('query.timeoutMs', '120000', 'user-1')`,
      )
      expect(await listener.flush()).toEqual([notification])

      await writer.query(`UPDATE platform.studio_settings SET value = 'true' WHERE key = 'ai.enabled'`)
      expect(await listener.flush()).toEqual([notification])

      // Nothing arrives before the commit and nothing after a rollback.
      await writer.query('BEGIN')
      await writer.query(`UPDATE platform.studio_settings SET value = '90000' WHERE key = 'query.timeoutMs'`)
      expect(await listener.flush()).toEqual([])
      await writer.query('COMMIT')
      expect(await listener.flush()).toEqual([notification])

      await writer.query('BEGIN')
      await writer.query('DELETE FROM platform.studio_settings')
      await writer.query('ROLLBACK')
      expect(await listener.flush()).toEqual([])

      await writer.query('DELETE FROM platform.studio_settings')
      expect(await listener.flush()).toEqual([notification])

      // A change of the allowlist, which only a migration makes, notifies too.
      await owner.query(`INSERT INTO platform.studio_setting_keys (key, "valueType", description) VALUES ($1, 'boolean', 'Probe')`, [key])
      expect(await listener.flush()).toEqual([notification])
      await owner.query('DELETE FROM platform.studio_setting_keys WHERE key = $1', [key])
      expect(await listener.flush()).toEqual([notification])
    } finally {
      await owner.query('DELETE FROM platform.studio_setting_keys WHERE key = $1', [key])
      await writer.query('DELETE FROM platform.studio_settings')
      await writer.end()
      await listener.close()
    }

    for (const table of ['platform.studio_settings', 'platform.studio_setting_keys']) {
      const triggers = await superuser.query<{ definition: string }>(
        `SELECT pg_get_triggerdef(oid) AS definition
           FROM pg_trigger
          WHERE tgrelid = $1::regclass AND NOT tgisinternal AND tgname = 'bridge_notify'`,
        [table],
      )
      expect(triggers.rows).toEqual([
        {
          definition: `CREATE TRIGGER bridge_notify AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION bridge.notify_change('settings')`,
        },
      ])
    }
  })

  it('the allowlist rows equal the registry of the vendored contract-v1.json', async () => {
    const expected = registry()
      .map(({ key, type, allowedValues, min, max, sinceContract, description }) => ({ key, type, allowedValues, min, max, sinceContract, description }))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
    expect(await allowlist(platform)).toEqual(expected)

    // The generated statements are idempotent: applying them again changes nothing.
    await owner.query('BEGIN')
    try {
      await owner.query(allowlistSql(registry()))
      await owner.query(allowlistSql(registry()))
      expect(await allowlist(owner)).toEqual(expected)
    } finally {
      await owner.query('ROLLBACK')
    }
  })
})
