import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowlistSql, allowlistRows } from './generate-studio-settings-allowlist.mjs'

const CONTRACT = path.join(__dirname, '..', 'tests', 'fixtures', 'governance', 'contract-v1.json')
const MIGRATIONS = path.join(__dirname, '..', 'prisma', 'migrations')

// Entries of the settings registry of Studio's contract-v1.json, with its camelCase fields.
const BOOLEAN = {
  key: 'ai.enabled',
  type: 'boolean',
  allowedValues: null,
  min: null,
  max: null,
  default: true,
  environment: null,
  consumer: 'guardRoute',
  sinceContract: 1,
  description: 'AI assistance routes are available',
}
const INTEGER = { ...BOOLEAN, key: 'query.timeoutMs', type: 'integer', min: 1000, max: 3600000, default: 60000, description: 'Statement timeout' }
const STRING = {
  ...BOOLEAN,
  key: 'queryLog.statementCapture',
  type: 'string',
  allowedValues: ['none', 'redacted', 'full'],
  default: 'none',
  sinceContract: 2,
  description: "What Studio records of a statement, in Studio's words",
}

describe('generate-studio-settings-allowlist', () => {
  it('emits one idempotent row per registry key with its type, allowed values and bounds', () => {
    const sql = allowlistSql([BOOLEAN, INTEGER, STRING])

    expect(sql).toBe(
      [
        'INSERT INTO platform.studio_setting_keys (key, "valueType", "allowedValues", "minValue", "maxValue", "sinceContract", description) VALUES',
        "  ('ai.enabled', 'boolean', NULL, NULL, NULL, 1, 'AI assistance routes are available'),",
        "  ('query.timeoutMs', 'integer', NULL, 1000, 3600000, 1, 'Statement timeout'),",
        `  ('queryLog.statementCapture', 'string', '["none","redacted","full"]'::jsonb, NULL, NULL, 2, 'What Studio records of a statement, in Studio''s words')`,
        'ON CONFLICT (key) DO UPDATE SET',
        '  "valueType" = EXCLUDED."valueType",',
        '  "allowedValues" = EXCLUDED."allowedValues",',
        '  "minValue" = EXCLUDED."minValue",',
        '  "maxValue" = EXCLUDED."maxValue",',
        '  "sinceContract" = EXCLUDED."sinceContract",',
        '  description = EXCLUDED.description;',
        '',
      ].join('\n'),
    )
  })

  it('maps the camelCase registry fields to the allowlist columns of platform.studio_setting_keys', () => {
    expect(allowlistRows([INTEGER, STRING])).toEqual([
      { key: 'query.timeoutMs', valueType: 'integer', allowedValues: null, minValue: 1000, maxValue: 3600000, sinceContract: 1, description: 'Statement timeout' },
      {
        key: 'queryLog.statementCapture',
        valueType: 'string',
        allowedValues: ['none', 'redacted', 'full'],
        minValue: null,
        maxValue: null,
        sinceContract: 2,
        description: "What Studio records of a statement, in Studio's words",
      },
    ])
  })

  it('refuses a registry entry the allowlist cannot hold', () => {
    expect(() => allowlistSql([])).toThrow(/no settings/)
    expect(() => allowlistSql([{ ...BOOLEAN, key: 'Ai.enabled' }])).toThrow(/Ai\.enabled/)
    expect(() => allowlistSql([{ ...BOOLEAN, type: 'number' }])).toThrow(/type/)
    expect(() => allowlistSql([{ ...BOOLEAN, min: 1 }])).toThrow(/bounds/)
    expect(() => allowlistSql([{ ...INTEGER, max: 1.5 }])).toThrow(/max/)
    expect(() => allowlistSql([{ ...STRING, allowedValues: ['none', 1] }])).toThrow(/allowed values/)
    expect(() => allowlistSql([{ ...BOOLEAN, sinceContract: 0 }])).toThrow(/sinceContract/)
    expect(() => allowlistSql([{ ...BOOLEAN, description: '' }])).toThrow(/description/)
    expect(() => allowlistSql([BOOLEAN, BOOLEAN])).toThrow(/twice/)
  })

  it('covers every key of the vendored contract-v1.json', () => {
    const { settings } = JSON.parse(readFileSync(CONTRACT, 'utf8'))
    const sql = allowlistSql(settings)
    for (const setting of settings) expect(sql).toContain(`('${setting.key}', '${setting.type}'`)
  })

  it('the latest migration that writes the allowlist holds the output for the vendored contract-v1.json', () => {
    const { settings } = JSON.parse(readFileSync(CONTRACT, 'utf8'))
    const writers = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map((name) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8'))
      .filter((sql) => sql.includes('INSERT INTO platform.studio_setting_keys'))
    expect(writers.length).toBeGreaterThan(0)
    expect(writers[writers.length - 1]).toContain(allowlistSql(settings))
  })
})
