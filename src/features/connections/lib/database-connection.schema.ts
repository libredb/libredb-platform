/**
 * The inputs of the connection actions. A definition and a credential set are checked against the schemas of
 * their engine in engines.ts: by the create schema, which knows the engine, and by parseEngineFields for an update,
 * whose engine may be the stored one. Every refusal names its field, such as `definition.database`, and never a value.
 *
 * Nothing here runs only on the server, so the connection form can validate with the same schemas.
 */
import { z } from 'zod'
import { ValidationError } from '@/shared/lib/errors'
import type { CredentialSet } from '@/shared/lib/sealing/lsb1'
import { ENGINE_IDS, ENGINES, isEngineId, type ConnectionDefinition, type EngineId } from './engines'

/** The environments a connection may name, as bridge.connections_v1 publishes them. */
export const CONNECTION_ENVIRONMENTS = ['production', 'staging', 'development', 'local', 'other'] as const

const READ_ONLY_CONFIRMATION = 'Confirm that the read credential can only read'

const name = z.string().trim().min(1, 'Name is required').max(128)
const environment = z.enum(CONNECTION_ENVIRONMENTS).nullable()
const groupName = z.string().trim().min(1, 'Group is required when set').max(64).nullable()
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be a color such as #1E88E5').nullable()
const readOnlyConfirmed = z.literal(true, { error: READ_ONLY_CONFIRMATION })
// The keys and values are the engine's to check.
const jsonObject = z.record(z.string(), z.unknown())

function createInput<E extends EngineId>(engine: E) {
  const spec = ENGINES[engine]
  return z.strictObject({
    engine: z.literal(engine),
    name,
    environment: environment.optional(),
    groupName: groupName.optional(),
    color: color.optional(),
    mcpEnabled: z.boolean().optional(),
    definition: spec.definition,
    // Required: Studio opens a connection with its read credential, which must be read-only.
    readCredential: spec.credential,
    writeCredential: spec.credential.optional(),
    readOnlyConfirmed,
  })
}

/** A new connection: its engine decides which definition and credential keys it may carry. */
export const createDatabaseConnectionSchema = z.discriminatedUnion(
  'engine',
  [
    createInput('postgres'),
    createInput('mysql'),
    createInput('mssql'),
    createInput('oracle'),
    createInput('mongodb'),
    createInput('redis'),
  ],
  { error: `must be one of ${ENGINE_IDS.join(', ')}` },
)

/**
 * A change to a connection. Absent fields stay as they are, and null clears an optional one. A changed engine or
 * definition needs the credentials again, which the action checks against the stored connection.
 */
export const updateDatabaseConnectionSchema = z
  .strictObject({
    id: z.string().min(1),
    name: name.optional(),
    environment: environment.optional(),
    groupName: groupName.optional(),
    color: color.optional(),
    mcpEnabled: z.boolean().optional(),
    active: z.boolean().optional(),
    engine: z.enum(ENGINE_IDS).optional(),
    definition: jsonObject.optional(),
    readCredential: jsonObject.optional(),
    writeCredential: jsonObject.optional(),
    removeWriteCredential: z.boolean().optional(),
    readOnlyConfirmed: readOnlyConfirmed.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.readCredential !== undefined && input.readOnlyConfirmed !== true) {
      ctx.addIssue({ code: 'custom', path: ['readOnlyConfirmed'], message: READ_ONLY_CONFIRMATION })
    }
    if (input.writeCredential !== undefined && input.removeWriteCredential === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['removeWriteCredential'],
        message: 'Give a new write credential or remove it, not both',
      })
    }
  })

/**
 * The body of PATCH /api/v1/connections/{id}: the switch alone, so the bearer API never reaches a definition or a
 * credential, and any other field is refused.
 */
export const setConnectionActiveSchema = z.strictObject({
  active: z.boolean(),
})

export const deleteDatabaseConnectionSchema = z.strictObject({
  id: z.string().min(1),
})

export type CreateDatabaseConnectionInput = z.infer<typeof createDatabaseConnectionSchema>
export type UpdateDatabaseConnectionInput = z.infer<typeof updateDatabaseConnectionSchema>

/** The engine fields an update sets, each checked against the engine's schema. */
export interface EngineFields {
  readonly definition?: ConnectionDefinition
  readonly readCredential?: CredentialSet
  readonly writeCredential?: CredentialSet
}

/**
 * Checks the definition and credentials that `input` sets against the schemas of `engine`, and returns them as the
 * schemas emit them. Throws a ValidationError with the issues of every refused field, or naming `engine` when Platform
 * does not offer it.
 */
export function parseEngineFields(
  engine: string,
  input: { definition?: unknown; readCredential?: unknown; writeCredential?: unknown },
): EngineFields {
  if (!isEngineId(engine)) {
    throw new ValidationError({ engine: [`must be one of ${ENGINE_IDS.join(', ')}`] })
  }
  const spec = ENGINES[engine]
  const fieldErrors: Record<string, string[]> = {}

  function parse<T>(field: string, schema: z.ZodType<T>, value: unknown): T | undefined {
    if (value === undefined) return undefined
    const result = schema.safeParse(value)
    if (result.success) return result.data
    for (const issue of result.error.issues) {
      const path = [field, ...issue.path.map(String)].join('.')
      fieldErrors[path] = [...(fieldErrors[path] ?? []), issue.message]
    }
    return undefined
  }

  const fields: EngineFields = {
    definition: parse('definition', spec.definition, input.definition),
    readCredential: parse('readCredential', spec.credential, input.readCredential),
    writeCredential: parse('writeCredential', spec.credential, input.writeCredential),
  }
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(fieldErrors)
  return fields
}
