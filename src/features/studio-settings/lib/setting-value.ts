// The rules of a Studio setting value against its allowlist row, shared by the actions and the form.
// The allowlist is generated from Studio's settings registry, so nothing here names a key except the held ones:
// the form and the checks work for any row a later Studio release adds.

export const STUDIO_SETTING_VALUE_TYPES = ['boolean', 'integer', 'string'] as const

export type StudioSettingValueType = (typeof STUDIO_SETTING_VALUE_TYPES)[number]

/** A JSON scalar, the only shape platform.studio_settings_validate() accepts for a value. */
export type StudioSettingValue = boolean | number | string

/**
 * Keys held off in governance mode until MCP and agent governance ship in v1.1.
 * Studio refuses them under governance whatever their value, so Platform shows them read-only and refuses to set them.
 */
export const HELD_STUDIO_SETTING_KEYS: readonly string[] = ['agent.enabled', 'mcp.enabled']

export const HELD_STUDIO_SETTING_NOTE = 'held off in governance mode until MCP and agent governance ship'

export function isHeldStudioSettingKey(key: string): boolean {
  return HELD_STUDIO_SETTING_KEYS.includes(key)
}

/** The columns of a platform.studio_setting_keys row that the rules read, as Prisma returns them. */
export interface StudioSettingKeyRow {
  key: string
  valueType: string
  allowedValues: unknown
  minValue: bigint | null
  maxValue: bigint | null
  description: string
}

/** One allowlisted key and its current value, in the serializable shape the form renders. */
export interface StudioSettingField {
  key: string
  valueType: StudioSettingValueType
  description: string
  allowedValues: StudioSettingValue[] | null
  minValue: number | null
  maxValue: number | null
  /** The value an admin set, or null when the key has no row and Studio applies its default. */
  value: StudioSettingValue | null
  updatedAt: string | null
  held: boolean
}

function valueTypeOf(row: StudioSettingKeyRow): StudioSettingValueType {
  const type = STUDIO_SETTING_VALUE_TYPES.find((candidate) => candidate === row.valueType)
  if (!type) throw new Error(`Studio setting ${row.key} has the unknown value type ${row.valueType}`)
  return type
}

function allowedValuesOf(row: StudioSettingKeyRow): StudioSettingValue[] | null {
  if (row.allowedValues === null || row.allowedValues === undefined) return null
  if (!Array.isArray(row.allowedValues)) {
    throw new Error(`Studio setting ${row.key} has allowed values that are not a JSON array`)
  }
  return row.allowedValues as StudioSettingValue[]
}

function scalarOf(key: string, value: unknown): StudioSettingValue {
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  throw new Error(`Studio setting ${key} holds a value that is not a JSON scalar`)
}

/** The form's view of an allowlist row and its optional value row. */
export function toStudioSettingField(
  row: StudioSettingKeyRow,
  setting: { value: unknown; updatedAt: Date } | null,
): StudioSettingField {
  return {
    key: row.key,
    valueType: valueTypeOf(row),
    description: row.description,
    allowedValues: allowedValuesOf(row),
    minValue: row.minValue === null ? null : Number(row.minValue),
    maxValue: row.maxValue === null ? null : Number(row.maxValue),
    value: setting ? scalarOf(row.key, setting.value) : null,
    updatedAt: setting ? setting.updatedAt.toISOString() : null,
    held: isHeldStudioSettingKey(row.key),
  }
}

/**
 * Checks a value against its allowlist row as platform.studio_settings_validate() does, and returns the message of
 * the first rule it breaks, or null when the value is valid.
 */
export function studioSettingValueError(row: StudioSettingKeyRow, value: unknown): string | null {
  const type = valueTypeOf(row)
  if (type === 'boolean' && typeof value !== 'boolean') return 'must be a boolean'
  if (type === 'string' && typeof value !== 'string') return 'must be a string'
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'must be a whole number'
    const below = row.minValue !== null && BigInt(value) < row.minValue
    const above = row.maxValue !== null && BigInt(value) > row.maxValue
    if (below || above) {
      if (row.minValue !== null && row.maxValue !== null) {
        return `must be between ${row.minValue} and ${row.maxValue}`
      }
      return row.minValue !== null ? `must be at least ${row.minValue}` : `must be at most ${row.maxValue}`
    }
  }
  const allowed = allowedValuesOf(row)
  if (allowed !== null && !allowed.includes(value as StudioSettingValue)) {
    return `must be one of ${allowed.join(', ')}`
  }
  return null
}
