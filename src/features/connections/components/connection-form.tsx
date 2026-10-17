'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Textarea } from '@/shared/components/ui/textarea'
import { ValidationError } from '@/shared/lib/errors'
import { canonicalDefinition, CanonicalJsonError } from '@/shared/lib/sealing/jcs'
import { createDatabaseConnection } from '../actions/create-database-connection'
import { updateDatabaseConnection } from '../actions/update-database-connection'
import {
  CONNECTION_ENVIRONMENTS,
  createDatabaseConnectionSchema,
  parseEngineFields,
  updateDatabaseConnectionSchema,
} from '../lib/database-connection.schema'
import { ENGINE_IDS, ENGINES, isEngineId, type ConnectionDefinition, type EngineId } from '../lib/engines'

/**
 * The connection form. It renders the fields of the chosen engine from the engine's schemas in engines.ts,
 * so it offers only the definition keys and values that Studio's definition allowlist admits, and it
 * validates with the schemas the actions use.
 *
 * It never receives a credential, so no credential input is ever prefilled. On an edit, empty credential inputs keep
 * the stored credentials, and a changed engine or definition asks for them again. Sending a read credential
 * needs the admin to confirm that it can only read, under the engine's least-privilege statements.
 */

/** What the edit form takes of a connection: never a credential or an envelope. */
export interface ConnectionFormConnection {
  id: string
  name: string
  engine: string
  environment: string | null
  groupName: string | null
  definition: ConnectionDefinition
  active: boolean
  hasWriteCredential: boolean
}

const DEFINITION_LABELS: Readonly<Record<string, string>> = {
  host: 'Host',
  port: 'Port',
  database: 'Database',
  serviceName: 'Service name',
  instanceName: 'Instance name',
  authSource: 'Authentication database',
  skipObjectScan: 'Skip the object scan',
}

const SSL_LABELS: Readonly<Record<string, string>> = {
  caCert: 'CA certificate',
  rejectUnauthorized: 'Reject unauthorized certificates',
}

const CREDENTIAL_LABELS: Readonly<Record<string, string>> = {
  user: 'User',
  password: 'Password',
  sslClientCert: 'Client certificate',
  sslClientKey: 'Client key',
}

const BOOLEAN_KEYS = new Set(['skipObjectScan', 'rejectUnauthorized'])
const NUMBER_KEYS = new Set(['port'])
const MULTILINE_KEYS = new Set(['caCert', 'sslClientCert', 'sslClientKey'])

/** A field of an engine schema, and whether the schema requires it. */
interface SchemaField {
  key: string
  required: boolean
}

interface EngineForm {
  definition: SchemaField[]
  ssl: { keys: SchemaField[]; modes: readonly string[] } | null
  credential: SchemaField[]
}

function objectShape(schema: z.ZodType, where: string): Record<string, z.ZodType> {
  if (!(schema instanceof z.ZodObject)) throw new Error(`${where} must be an object schema`)
  return schema.shape as Record<string, z.ZodType>
}

function fieldsOf(shape: Record<string, z.ZodType>): SchemaField[] {
  return Object.entries(shape).map(([key, schema]) => ({ key, required: schema.def.type !== 'optional' }))
}

// Both optional() and exactOptional() report the def type `optional` and keep the inner schema in `innerType`.
function unwrapOptional(schema: z.ZodType): z.ZodType {
  return schema.def.type === 'optional' ? (schema.def as unknown as { innerType: z.ZodType }).innerType : schema
}

function requireLabels(fields: SchemaField[], labels: Readonly<Record<string, string>>, prefix: string) {
  for (const { key } of fields) {
    if (labels[key] === undefined) throw new Error(`The connection form has no label for ${prefix}${key}`)
  }
}

/** The fields the form renders for an engine, read from its definition and credential schemas. */
function engineForm(engine: EngineId): EngineForm {
  const spec = ENGINES[engine]
  const { ssl, ...rest } = objectShape(spec.definition, `The definition schema of ${engine}`)
  let sslForm: EngineForm['ssl'] = null
  if (ssl !== undefined) {
    const { mode, ...sslRest } = objectShape(unwrapOptional(ssl), `The ssl schema of ${engine}`)
    if (!(mode instanceof z.ZodEnum)) throw new Error(`The ssl.mode schema of ${engine} must be an enum`)
    sslForm = { keys: fieldsOf(sslRest), modes: mode.options.map(String) }
  }
  const form: EngineForm = {
    definition: fieldsOf(rest),
    ssl: sslForm,
    credential: fieldsOf(objectShape(spec.credential, `The credential schema of ${engine}`)),
  }
  requireLabels(form.definition, DEFINITION_LABELS, '')
  requireLabels(form.ssl?.keys ?? [], SSL_LABELS, 'ssl.')
  requireLabels(form.credential, CREDENTIAL_LABELS, 'the credential key ')
  return form
}

/** The values of the definition inputs, keyed by their path such as `host` or `ssl.mode`. */
type DefinitionValues = Record<string, string | boolean | undefined>
type CredentialValues = Record<string, string>

function definitionValues(definition: ConnectionDefinition): DefinitionValues {
  const values: DefinitionValues = {}
  for (const [key, value] of Object.entries(definition)) {
    if (key === 'ssl' && typeof value === 'object' && value !== null) {
      for (const [sslKey, sslValue] of Object.entries(value)) {
        values[`ssl.${sslKey}`] = typeof sslValue === 'boolean' ? sslValue : String(sslValue)
      }
    } else {
      values[key] = typeof value === 'boolean' ? value : String(value)
    }
  }
  return values
}

/** A value as the schema takes it, or undefined for an input left empty. */
function definitionValue(key: string, value: string | boolean | undefined): unknown {
  if (value === undefined || value === '') return undefined
  if (typeof value === 'boolean') return value
  if (NUMBER_KEYS.has(key)) return Number(value)
  return value
}

/** The definition the inputs describe for an engine: only its keys, and an ssl object only with a mode chosen. */
function buildDefinition(form: EngineForm, values: DefinitionValues): Record<string, unknown> {
  const definition: Record<string, unknown> = {}
  for (const { key } of form.definition) {
    const value = definitionValue(key, values[key])
    if (value !== undefined) definition[key] = value
  }
  const mode = values['ssl.mode']
  if (form.ssl !== null && typeof mode === 'string' && mode !== '') {
    const ssl: Record<string, unknown> = { mode }
    for (const { key } of form.ssl.keys) {
      const value = definitionValue(key, values[`ssl.${key}`])
      if (value !== undefined) ssl[key] = value
    }
    definition.ssl = ssl
  }
  return definition
}

/** A credential set from its inputs, or undefined when every input is empty. */
function buildCredential(form: EngineForm, values: CredentialValues): Record<string, string> | undefined {
  const credential: Record<string, string> = {}
  for (const { key } of form.credential) {
    if (values[key] !== undefined && values[key] !== '') credential[key] = values[key]
  }
  return Object.keys(credential).length === 0 ? undefined : credential
}

type FieldErrors = Record<string, string[]>

function issuesToFieldErrors(issues: readonly z.core.$ZodIssue[]): FieldErrors {
  const fieldErrors: FieldErrors = {}
  for (const issue of issues) {
    const key = issue.path.map(String).join('.')
    fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message]
  }
  return fieldErrors
}

function mergeFieldErrors(...all: FieldErrors[]): FieldErrors {
  const merged: FieldErrors = {}
  for (const errors of all) {
    for (const [key, messages] of Object.entries(errors)) {
      merged[key] = [...new Set([...(merged[key] ?? []), ...messages])]
    }
  }
  return merged
}

/** The write credential choice: none, keep the stored one, set a new one, or remove the stored one. */
type WriteChoice = 'none' | 'keep' | 'set' | 'remove'

// The messages of updateDatabaseConnection for the same refusal.
const REBIND_READ = 'A changed engine or definition needs the read credential again'
const REBIND_WRITE = 'A changed engine or definition needs the write credential again, or its removal'

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 md:text-sm dark:bg-white/5 dark:border-white/10'
const CHECKBOX_CLASS = 'size-4 accent-primary'

function FieldError({ messages }: { messages: string[] | undefined }) {
  if (messages === undefined || messages.length === 0) return null
  return (
    <>
      {messages.map((message) => (
        <p key={message} className="text-xs text-destructive">
          {message}
        </p>
      ))}
    </>
  )
}

function OptionalHint({ required }: { required: boolean }) {
  return required ? null : <span className="text-xs text-muted-foreground">Optional</span>
}

interface TextFieldProps {
  id: string
  label: string
  required: boolean
  value: string
  onChange: (value: string) => void
  messages: string[] | undefined
  type?: 'text' | 'number' | 'password'
  multiline?: boolean
}

function TextField({ id, label, required, value, onChange, messages, type = 'text', multiline = false }: TextFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        <OptionalHint required={required} />
      </div>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={type}
          value={value}
          autoComplete={type === 'password' ? 'new-password' : 'off'}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <FieldError messages={messages} />
    </div>
  )
}

function CheckboxField(props: {
  id: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  messages: string[] | undefined
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          id={props.id}
          type="checkbox"
          className={CHECKBOX_CLASS}
          checked={props.checked}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <Label htmlFor={props.id}>{props.label}</Label>
      </div>
      <FieldError messages={props.messages} />
    </div>
  )
}

interface CredentialFieldsProps {
  legend: string
  idPrefix: string
  fields: SchemaField[]
  values: CredentialValues
  onChange: (key: string, value: string) => void
  errors: FieldErrors
  errorKey: string
  hint?: string
}

function CredentialFields({ legend, idPrefix, fields, values, onChange, errors, errorKey, hint }: CredentialFieldsProps) {
  return (
    <fieldset className="space-y-3 rounded-md border border-border/60 p-4">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <FieldError messages={errors[errorKey]} />
      {fields.map(({ key, required }) => (
        <TextField
          key={key}
          id={`${idPrefix}-${key}`}
          label={CREDENTIAL_LABELS[key]}
          required={required}
          type={key === 'password' ? 'password' : 'text'}
          multiline={MULTILINE_KEYS.has(key)}
          value={values[key] ?? ''}
          onChange={(value) => onChange(key, value)}
          messages={errors[`${errorKey}.${key}`]}
        />
      ))}
    </fieldset>
  )
}

export function ConnectionForm({ connection }: { connection?: ConnectionFormConnection }) {
  const router = useRouter()
  const isEdit = connection !== undefined
  const [isPending, startTransition] = useTransition()

  if (connection !== undefined && !isEngineId(connection.engine)) {
    throw new Error(`Connection ${connection.id} has the engine ${connection.engine}, which Platform does not offer`)
  }
  const storedEngine = connection?.engine as EngineId | undefined

  const [engine, setEngine] = useState<EngineId>(storedEngine ?? 'postgres')
  const [name, setName] = useState(connection?.name ?? '')
  const [environment, setEnvironment] = useState(connection?.environment ?? '')
  const [groupName, setGroupName] = useState(connection?.groupName ?? '')
  const [active, setActive] = useState(connection?.active ?? true)
  const [definition, setDefinition] = useState<DefinitionValues>(() =>
    connection === undefined ? {} : definitionValues(connection.definition),
  )
  const [readCredential, setReadCredential] = useState<CredentialValues>({})
  const [writeCredential, setWriteCredential] = useState<CredentialValues>({})
  const [writeChoice, setWriteChoice] = useState<WriteChoice>(connection?.hasWriteCredential ? 'keep' : 'none')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})

  const form = engineForm(engine)
  const spec = ENGINES[engine]
  const builtDefinition = buildDefinition(form, definition)
  const readSet = buildCredential(form, readCredential)
  const writeSet = writeChoice === 'set' ? (buildCredential(form, writeCredential) ?? {}) : undefined

  // Each envelope is bound to the engine and the exact definition, so changing either asks for the
  // credentials again. A definition value with no canonical form, such as a port that is not an integer, is a change
  // that the schema then refuses.
  const engineChanged = isEdit && engine !== storedEngine
  let definitionChanged = false
  if (connection !== undefined) {
    try {
      definitionChanged = canonicalDefinition(builtDefinition) !== canonicalDefinition(connection.definition)
    } catch (error) {
      if (!(error instanceof CanonicalJsonError)) throw error
      definitionChanged = true
    }
  }
  const rebinds = engineChanged || definitionChanged
  // A read credential is sent on create, on a rebind, and whenever the admin enters one; each needs the confirmation.
  const confirmationNeeded = !isEdit || rebinds || readSet !== undefined
  const submitBlocked = isPending || (confirmationNeeded && !confirmed)

  function changeDefinition(key: string, value: string | boolean) {
    setDefinition((current) => ({ ...current, [key]: value }))
  }

  function validateCreate(): { input: unknown; fieldErrors: FieldErrors } {
    const input = {
      engine,
      name,
      ...(environment === '' ? {} : { environment }),
      ...(groupName.trim() === '' ? {} : { groupName }),
      definition: builtDefinition,
      readCredential: readSet ?? {},
      ...(writeSet === undefined ? {} : { writeCredential: writeSet }),
      readOnlyConfirmed: confirmed,
    }
    const parsed = createDatabaseConnectionSchema.safeParse(input)
    return { input, fieldErrors: parsed.success ? {} : issuesToFieldErrors(parsed.error.issues) }
  }

  function validateUpdate(stored: ConnectionFormConnection): { input: unknown; fieldErrors: FieldErrors } {
    const input = {
      id: stored.id,
      name,
      environment: environment === '' ? null : environment,
      groupName: groupName.trim() === '' ? null : groupName,
      active,
      ...(engineChanged ? { engine } : {}),
      ...(rebinds ? { definition: builtDefinition } : {}),
      ...(readSet === undefined ? {} : { readCredential: readSet }),
      ...(writeSet === undefined ? {} : { writeCredential: writeSet }),
      ...(writeChoice === 'remove' ? { removeWriteCredential: true } : {}),
      ...(readSet === undefined ? {} : { readOnlyConfirmed: confirmed }),
    }
    const parsed = updateDatabaseConnectionSchema.safeParse(input)
    const schemaErrors = parsed.success ? {} : issuesToFieldErrors(parsed.error.issues)

    let engineErrors: FieldErrors = {}
    try {
      parseEngineFields(engine, { definition: builtDefinition, readCredential: readSet, writeCredential: writeSet })
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error
      engineErrors = error.fieldErrors
    }

    const rebindErrors: FieldErrors = {}
    if (rebinds) {
      if (readSet === undefined) rebindErrors.readCredential = [REBIND_READ]
      if (stored.hasWriteCredential && writeChoice === 'keep') rebindErrors.writeCredential = [REBIND_WRITE]
    }
    return { input, fieldErrors: mergeFieldErrors(schemaErrors, engineErrors, rebindErrors) }
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitBlocked) return
    const { input, fieldErrors } = connection === undefined ? validateCreate() : validateUpdate(connection)
    setErrors(fieldErrors)
    if (Object.keys(fieldErrors).length > 0) return

    startTransition(async () => {
      // The inputs passed the schemas of the actions above, which parse them again on the server.
      const result =
        connection === undefined
          ? await createDatabaseConnection(input as Parameters<typeof createDatabaseConnection>[0])
          : await updateDatabaseConnection(input as Parameters<typeof updateDatabaseConnection>[0])
      if (result.success) {
        toast.success(isEdit ? 'Connection updated' : 'Connection created')
        router.push('/connections')
      } else {
        setErrors(result.fieldErrors ?? {})
        toast.error(result.error)
      }
    })
  }

  // Field errors that no input shows, so that none is hidden.
  const shownKeys = new Set<string>([
    'name',
    'environment',
    'groupName',
    'engine',
    'readOnlyConfirmed',
    'readCredential',
    'writeCredential',
    'removeWriteCredential',
    ...form.definition.map(({ key }) => `definition.${key}`),
    'definition.ssl.mode',
    ...(form.ssl?.keys ?? []).map(({ key }) => `definition.ssl.${key}`),
    ...form.credential.flatMap(({ key }) => [`readCredential.${key}`, `writeCredential.${key}`]),
  ])
  const otherErrors = Object.entries(errors).filter(([key]) => !shownKeys.has(key))

  const writeOptions: { value: WriteChoice; label: string }[] = connection?.hasWriteCredential
    ? [
        { value: 'keep', label: 'Keep the stored write credential' },
        { value: 'set', label: 'Replace the write credential' },
        { value: 'remove', label: 'Remove the write credential' },
      ]
    : [
        { value: 'none', label: 'No write credential' },
        { value: 'set', label: 'Add a write credential' },
      ]

  const sslMode = typeof definition['ssl.mode'] === 'string' ? definition['ssl.mode'] : ''

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-6" noValidate>
      <section className="space-y-4">
        <h3 className="text-sm font-semibold tracking-tight font-heading">Connection</h3>
        <TextField
          id="connection-name"
          label="Name"
          required
          value={name}
          onChange={setName}
          messages={errors.name}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="connection-environment">Environment</Label>
              <OptionalHint required={false} />
            </div>
            <select
              id="connection-environment"
              className={SELECT_CLASS}
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
            >
              <option value="">None</option>
              {CONNECTION_ENVIRONMENTS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <FieldError messages={errors.environment} />
          </div>
          <TextField
            id="connection-group"
            label="Group"
            required={false}
            value={groupName}
            onChange={setGroupName}
            messages={errors.groupName}
          />
        </div>
        {isEdit && (
          <CheckboxField
            id="connection-active"
            label="Active: Studio serves the connection"
            checked={active}
            onChange={setActive}
            messages={errors.active}
          />
        )}
      </section>

      <div className="border-t border-border/50 dark:border-white/5" />

      <section className="space-y-4">
        <h3 className="text-sm font-semibold tracking-tight font-heading">Database</h3>
        <div className="space-y-2">
          <Label htmlFor="connection-engine">Engine</Label>
          <select
            id="connection-engine"
            className={SELECT_CLASS}
            value={engine}
            onChange={(event) => {
              const next = event.target.value
              if (!isEngineId(next)) throw new Error(`${next} is not an engine Platform offers`)
              setEngine(next)
            }}
          >
            {ENGINE_IDS.map((id) => (
              <option key={id} value={id}>
                {ENGINES[id].label}
              </option>
            ))}
          </select>
          <FieldError messages={errors.engine} />
        </div>

        {form.definition.map(({ key, required }) =>
          BOOLEAN_KEYS.has(key) ? (
            <CheckboxField
              key={key}
              id={`definition-${key}`}
              label={DEFINITION_LABELS[key]}
              checked={definition[key] === true}
              onChange={(checked) => changeDefinition(key, checked)}
              messages={errors[`definition.${key}`]}
            />
          ) : (
            <TextField
              key={key}
              id={`definition-${key}`}
              label={DEFINITION_LABELS[key]}
              required={required}
              type={NUMBER_KEYS.has(key) ? 'number' : 'text'}
              value={typeof definition[key] === 'string' ? definition[key] : ''}
              onChange={(value) => changeDefinition(key, value)}
              messages={errors[`definition.${key}`]}
            />
          ),
        )}

        {form.ssl !== null && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="definition-ssl-mode">SSL mode</Label>
                <OptionalHint required={false} />
              </div>
              <select
                id="definition-ssl-mode"
                className={SELECT_CLASS}
                value={sslMode}
                onChange={(event) => changeDefinition('ssl.mode', event.target.value)}
              >
                <option value="">No SSL settings</option>
                {form.ssl.modes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
              <FieldError messages={errors['definition.ssl.mode']} />
            </div>
            {sslMode !== '' &&
              form.ssl.keys.map(({ key, required }) => {
                const path = `ssl.${key}`
                return BOOLEAN_KEYS.has(key) ? (
                  <CheckboxField
                    key={key}
                    id={`definition-ssl-${key}`}
                    label={SSL_LABELS[key]}
                    checked={definition[path] === true}
                    onChange={(checked) => changeDefinition(path, checked)}
                    messages={errors[`definition.${path}`]}
                  />
                ) : (
                  <TextField
                    key={key}
                    id={`definition-ssl-${key}`}
                    label={SSL_LABELS[key]}
                    required={required}
                    multiline={MULTILINE_KEYS.has(key)}
                    value={typeof definition[path] === 'string' ? definition[path] : ''}
                    onChange={(value) => changeDefinition(path, value)}
                    messages={errors[`definition.${path}`]}
                  />
                )
              })}
          </div>
        )}
      </section>

      <div className="border-t border-border/50 dark:border-white/5" />

      <section className="space-y-4">
        <h3 className="text-sm font-semibold tracking-tight font-heading">Credentials</h3>
        <p className="text-sm text-muted-foreground">
          Credentials are sealed to Studio&apos;s key and never shown again.
        </p>
        {isEdit && rebinds && (
          <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            The engine or definition changed, so enter the read credential again, and give a new write credential or
            remove the stored one.
          </p>
        )}

        <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-4">
          <p className="text-sm font-medium">Least-privilege setup for {spec.label}</p>
          <p className="text-xs text-muted-foreground">
            Studio opens the connection with the read credential, so create it as a principal that can only read:
          </p>
          <pre data-testid="least-privilege-sql" className="overflow-x-auto rounded bg-background p-3 font-mono text-xs">
            {spec.guidance.statements}
          </pre>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {spec.guidance.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>

        <CredentialFields
          legend="Read credential"
          idPrefix="read"
          fields={form.credential}
          values={readCredential}
          onChange={(key, value) => setReadCredential((current) => ({ ...current, [key]: value }))}
          errors={errors}
          errorKey="readCredential"
          hint={isEdit && !rebinds ? 'Leave empty to keep the stored read credential.' : undefined}
        />

        <div className="space-y-1">
          <div className="flex items-start gap-2">
            <input
              id="read-only-confirmed"
              type="checkbox"
              className={`mt-0.5 ${CHECKBOX_CLASS}`}
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <Label htmlFor="read-only-confirmed" className="font-normal leading-snug">
              I confirm that the read credential can only read, as the statements above set it up.
            </Label>
          </div>
          <FieldError messages={errors.readOnlyConfirmed} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="write-choice">Write credential</Label>
          <select
            id="write-choice"
            className={SELECT_CLASS}
            value={writeChoice}
            onChange={(event) => setWriteChoice(event.target.value as WriteChoice)}
          >
            {writeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">Studio uses the write credential for users granted write access.</p>
          <FieldError messages={errors.writeCredential} />
          <FieldError messages={errors.removeWriteCredential} />
        </div>
        {writeChoice === 'set' && (
          <CredentialFields
            legend="New write credential"
            idPrefix="write"
            fields={form.credential}
            values={writeCredential}
            onChange={(key, value) => setWriteCredential((current) => ({ ...current, [key]: value }))}
            errors={errors}
            errorKey="writeCredential"
          />
        )}
      </section>

      {otherErrors.length > 0 && (
        <ul role="alert" className="space-y-1 text-xs text-destructive">
          {otherErrors.map(([key, messages]) => (
            <li key={key}>
              {key === '' ? messages.join(', ') : `${key}: ${messages.join(', ')}`}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border/50 dark:border-white/5" />

      <div className="flex gap-3">
        <Button type="submit" disabled={submitBlocked}>
          {isPending ? (isEdit ? 'Saving...' : 'Creating...') : isEdit ? 'Save changes' : 'Create connection'}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push('/connections')}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
