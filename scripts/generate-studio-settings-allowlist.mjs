// Generates the rows of platform.studio_setting_keys from the settings registry of Studio's contract-v1.json.
// The allowlist changes only through migrations built from this output, never by hand.
//
//   node scripts/generate-studio-settings-allowlist.mjs [path/to/contract-v1.json]
//     prints idempotent `INSERT ... ON CONFLICT (key) DO UPDATE` statements for every registry key.
//     The default path is the vendored tests/fixtures/governance/contract-v1.json.
//
// When a vendored Studio build adds a key or changes one, paste the output into a new migration.
// Removing a key is never generated: it deletes the value an admin set, so a migration does it on purpose.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONTRACT = path.join(ROOT, 'tests', 'fixtures', 'governance', 'contract-v1.json')

// The CHECKs that the migrations put on platform.studio_setting_keys.
const KEY_PATTERN = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/
const VALUE_TYPES = ['boolean', 'integer', 'string']

/**
 * @typedef {{
 *   key: string,
 *   type: string,
 *   allowedValues: unknown[] | null,
 *   min: number | null,
 *   max: number | null,
 *   sinceContract: number,
 *   description: string,
 * }} RegistryEntry
 * @typedef {{
 *   key: string,
 *   valueType: string,
 *   allowedValues: unknown[] | null,
 *   minValue: number | null,
 *   maxValue: number | null,
 *   sinceContract: number,
 *   description: string,
 * }} AllowlistRow
 */

/** @param {unknown} value @param {string} type */
function hasType(value, type) {
  if (type === 'integer') return Number.isSafeInteger(value)
  return typeof value === type
}

/**
 * Maps Studio's camelCase registry entries to the columns of platform.studio_setting_keys, and refuses an entry
 * the allowlist cannot hold.
 * @param {RegistryEntry[]} settings
 * @returns {AllowlistRow[]}
 */
export function allowlistRows(settings) {
  if (!Array.isArray(settings) || settings.length === 0) throw new Error('The settings registry has no settings.')
  const seen = new Set()
  return settings.map((setting) => {
    const { key, type, allowedValues, min, max, sinceContract, description } = setting
    const where = `Setting ${JSON.stringify(key)}`
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new Error(`${where} does not match ${KEY_PATTERN}.`)
    if (seen.has(key)) throw new Error(`${where} appears twice in the registry.`)
    seen.add(key)
    if (!VALUE_TYPES.includes(type)) throw new Error(`${where} has type ${JSON.stringify(type)}, not one of ${VALUE_TYPES.join(', ')}.`)
    if (allowedValues !== null && (!Array.isArray(allowedValues) || allowedValues.length === 0 || !allowedValues.every((value) => hasType(value, type)))) {
      throw new Error(`${where} has allowed values that are not a non-empty array of ${type} values.`)
    }
    if (type !== 'integer' && (min !== null || max !== null)) throw new Error(`${where} of type ${type} has bounds.`)
    for (const [name, bound] of [['min', min], ['max', max]]) {
      if (bound !== null && !Number.isSafeInteger(bound)) throw new Error(`${where} has a ${name} that is not an integer.`)
    }
    if (min !== null && max !== null && min > max) throw new Error(`${where} has a min above its max.`)
    if (!Number.isInteger(sinceContract) || sinceContract < 1 || sinceContract > 32767) {
      throw new Error(`${where} has a sinceContract that is not a positive smallint.`)
    }
    if (typeof description !== 'string' || description.length === 0) throw new Error(`${where} has no description.`)
    return { key, valueType: type, allowedValues, minValue: min, maxValue: max, sinceContract, description }
  })
}

/** @param {string} text */
function literal(text) {
  return `'${text.replaceAll("'", "''")}'`
}

/** @param {number | null} value */
function nullable(value) {
  return value === null ? 'NULL' : String(value)
}

/**
 * Returns one idempotent statement that inserts every registry key into platform.studio_setting_keys, or updates
 * the row of a key that is already there.
 * @param {RegistryEntry[]} settings
 * @returns {string}
 */
export function allowlistSql(settings) {
  const rows = allowlistRows(settings).map(
    (row) =>
      `  (${[
        literal(row.key),
        literal(row.valueType),
        row.allowedValues === null ? 'NULL' : `${literal(JSON.stringify(row.allowedValues))}::jsonb`,
        nullable(row.minValue),
        nullable(row.maxValue),
        String(row.sinceContract),
        literal(row.description),
      ].join(', ')})`,
  )
  return [
    'INSERT INTO platform.studio_setting_keys (key, "valueType", "allowedValues", "minValue", "maxValue", "sinceContract", description) VALUES',
    rows.join(',\n'),
    'ON CONFLICT (key) DO UPDATE SET',
    '  "valueType" = EXCLUDED."valueType",',
    '  "allowedValues" = EXCLUDED."allowedValues",',
    '  "minValue" = EXCLUDED."minValue",',
    '  "maxValue" = EXCLUDED."maxValue",',
    '  "sinceContract" = EXCLUDED."sinceContract",',
    '  description = EXCLUDED.description;',
    '',
  ].join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1) throw new Error('Usage: node scripts/generate-studio-settings-allowlist.mjs [path/to/contract-v1.json]')
    const manifest = JSON.parse(readFileSync(args[0] ?? DEFAULT_CONTRACT, 'utf8'))
    process.stdout.write(allowlistSql(manifest.settings))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
