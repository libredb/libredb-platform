import { z } from 'zod'
import { deploymentModeSchema, type DeploymentMode } from './deployment'
import { ConfigError } from './errors'
import {
  KEYCLOAK_ADMIN_URL_RULE,
  KEYCLOAK_ISSUER_RULE,
  parseKeycloakBaseUrl,
  parseKeycloakIssuer,
} from './keycloak/config'
import { parseSealPublicKey, SEAL_PUBLIC_KEY_RULE } from './sealing/seal-key'

export type RuntimeEnv = Readonly<Record<string, string | undefined>>

const REQUIRED = 'is required'
const REQUIRED_SELF_HOSTED = 'is required in self-hosted mode'

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** True for an absolute URL whose scheme is http or https. */
export function isAbsoluteHttpUrl(value: string): boolean {
  const url = parseUrl(value)
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:')
}

function isPostgresqlUrl(value: string): boolean {
  return value.startsWith('postgresql://') && parseUrl(value) !== null
}

/**
 * True when the URL selects schema platform, where Prisma keeps every table.
 * The parameter tells Platform's tools which schema the URL is for; Prisma qualifies every query with the schema itself.
 */
function selectsPlatformSchema(value: string): boolean {
  const schemas = parseUrl(value)?.searchParams.getAll('schema') ?? []
  return schemas.length === 1 && schemas[0] === 'platform'
}

/** Days a query event is kept; the database keeps every event younger than 7 days whatever the value. */
const DEFAULT_QUERY_LOG_RETENTION_DAYS = 90
/** A century: a longer retention would reach before the earliest timestamp PostgreSQL can subtract to. */
const MAX_QUERY_LOG_RETENTION_DAYS = 36_500

/** Seconds between two rechecks of a Keycloak session against the Admin API. */
const DEFAULT_SESSION_RECHECK_SECONDS = 300
/** Seconds after its last successful recheck that a session outlives a directory it cannot read. */
const DEFAULT_RECHECK_GRACE_SECONDS = 900
/** A day: a longer interval or grace would leave a removed admin in Platform for longer than any install intends. */
const MAX_SESSION_RECHECK_SECONDS = 86_400

/** Seconds between two runs of directory sync, which ends the Studio sessions of a member who lost a role. */
const DEFAULT_DIRECTORY_SYNC_INTERVAL_SEC = 60
/** A day: a longer interval would leave a removed user in Studio for longer than any install intends. */
const MAX_DIRECTORY_SYNC_INTERVAL_SEC = 86_400

function positiveInteger(fallback: number, max: number) {
  const rule = `must be a positive integer of at most ${max}`
  return z.string()
    .refine(value => /^[1-9][0-9]*$/.test(value) && Number(value) <= max, rule)
    .transform(Number)
    .default(fallback)
}

// A claim or role name is compared exactly, so surrounding whitespace is a typo that would never match a token.
function exactName(fallback: string) {
  return z.string().refine(value => value === value.trim(), 'must not start or end with a space').default(fallback)
}

function httpUrl(whenMissing = REQUIRED) {
  return z.string({ error: whenMissing }).refine(isAbsoluteHttpUrl, 'must be an absolute http(s) URL')
}

function keycloakIssuer(whenMissing = REQUIRED) {
  return z.string({ error: whenMissing }).refine(value => parseKeycloakIssuer(value) !== null, KEYCLOAK_ISSUER_RULE)
}

function keycloakBaseUrl() {
  return z.string().refine(value => parseKeycloakBaseUrl(value) !== null, KEYCLOAK_ADMIN_URL_RULE)
}

function sealPublicKey(whenMissing = REQUIRED) {
  return z.string({ error: whenMissing }).refine(value => parseSealPublicKey(value) !== null, SEAL_PUBLIC_KEY_RULE)
}

/**
 * The schema of one deployment mode. `next start` sets NODE_ENV to production, which also requires AUTH_URL.
 * Every message names the problem and never repeats the value, because a value may be a secret.
 * A new variable joins this schema with a failing test first.
 */
function runtimeSchema(mode: DeploymentMode | undefined, production: boolean) {
  const selfHosted = mode === 'self-hosted'
  return z.object({
    DEPLOYMENT_MODE: deploymentModeSchema,
    DATABASE_URL: z.string({ error: REQUIRED })
      .refine(isPostgresqlUrl, { error: 'must be a postgresql:// URL', abort: true })
      .refine(selectsPlatformSchema, 'must include schema=platform'),
    AUTH_SECRET: z.string({ error: REQUIRED }).min(32, 'must be at least 32 characters'),
    // Set only during a rotation: session tokens signed with the previous secret stay readable.
    AUTH_SECRET_PREVIOUS: z.string().min(32, 'must be at least 32 characters').optional(),
    AUTH_URL: production ? httpUrl('is required when NODE_ENV is production') : httpUrl().optional(),
    STUDIO_PUBLIC_URL: selfHosted ? httpUrl(REQUIRED_SELF_HOSTED) : httpUrl().optional(),
    // Platform signs in through Keycloak in self-hosted mode and reads its directory as the client's service account.
    AUTH_KEYCLOAK_ISSUER: selfHosted ? keycloakIssuer(REQUIRED_SELF_HOSTED) : keycloakIssuer().optional(),
    AUTH_KEYCLOAK_ID: selfHosted ? z.string({ error: REQUIRED_SELF_HOSTED }) : z.string().optional(),
    AUTH_KEYCLOAK_SECRET: selfHosted ? z.string({ error: REQUIRED_SELF_HOSTED }) : z.string().optional(),
    KEYCLOAK_ADMIN_URL: keycloakBaseUrl().optional(),
    // Studio's seal public key, which every connection credential is sealed to. register() runs its self-test
    // seal in either mode, and self-hosted mode, which requires it, publishes its canary for Studio.
    BRIDGE_SEAL_PUBLIC_KEY: selfHosted ? sealPublicKey(REQUIRED_SELF_HOSTED) : sealPublicKey().optional(),
    // The flat ID-token claim that carries the client roles of libredb, and the roles of Platform admins and Studio
    // users in it. The callbacks read the claim by its whole name, so the role model stays in the realm.
    PLATFORM_ROLE_CLAIM: exactName('libredb_roles'),
    PLATFORM_ADMIN_ROLE: exactName('admin'),
    STUDIO_USER_ROLE: exactName('user'),
    // How often a Keycloak session asks the Admin API whether it still stands, and how long it outlives an Admin API
    // that cannot be read.
    PLATFORM_SESSION_RECHECK_SECONDS: positiveInteger(DEFAULT_SESSION_RECHECK_SECONDS, MAX_SESSION_RECHECK_SECONDS),
    PLATFORM_RECHECK_GRACE_SECONDS: positiveInteger(DEFAULT_RECHECK_GRACE_SECONDS, MAX_SESSION_RECHECK_SECONDS),
    QUERY_LOG_RETENTION_DAYS: positiveInteger(DEFAULT_QUERY_LOG_RETENTION_DAYS, MAX_QUERY_LOG_RETENTION_DAYS),
    // How often directory sync lists the members of PLATFORM_ADMIN_ROLE and STUDIO_USER_ROLE in self-hosted mode.
    DIRECTORY_SYNC_INTERVAL_SEC: positiveInteger(DEFAULT_DIRECTORY_SYNC_INTERVAL_SEC, MAX_DIRECTORY_SYNC_INTERVAL_SEC),
    // The license token that every self-hosted install needs, with no rule of its form here: license/install-license.ts
    // verifies it, and a token that fails verification adds no seat but never stops the start.
    PLATFORM_LICENSE: selfHosted ? z.string({ error: REQUIRED_SELF_HOSTED }) : z.string().optional(),
  }).refine(config => config.AUTH_SECRET_PREVIOUS !== config.AUTH_SECRET, {
    path: ['AUTH_SECRET_PREVIOUS'],
    message: 'must differ from AUTH_SECRET',
  }).refine(config => config.PLATFORM_ADMIN_ROLE !== config.STUDIO_USER_ROLE, {
    // One role for both would sign every Studio user in to Platform as an admin.
    path: ['PLATFORM_ADMIN_ROLE'],
    message: 'must differ from STUDIO_USER_ROLE',
  })
}

export type RuntimeConfig = z.infer<ReturnType<typeof runtimeSchema>>

/** The name of every variable the runtime schema reads; docs/deploy/platform-runtime.md lists each of them. */
export function runtimeVariableNames(): string[] {
  return Object.keys(runtimeSchema('self-hosted', true).shape)
}

// An empty value, such as the line `NAME=` in an env file, counts as unset.
function withoutEmptyValues(env: RuntimeEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''),
  )
}

/**
 * Validates the variables Platform reads at runtime.
 * Throws one ConfigError that lists every missing or invalid variable by name.
 */
export function readRuntimeConfig(env: RuntimeEnv): RuntimeConfig {
  const input = withoutEmptyValues(env)
  // An invalid DEPLOYMENT_MODE reports itself, and the variables that every mode reads are still checked.
  const mode = deploymentModeSchema.safeParse(input.DEPLOYMENT_MODE)
  const result = runtimeSchema(mode.success ? mode.data : undefined, env.NODE_ENV === 'production').safeParse(input)
  if (!result.success) {
    const problems = result.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`)
    throw new ConfigError(`Invalid runtime configuration: ${problems.join('; ')}`)
  }
  return result.data
}

let cached: RuntimeConfig | undefined

/** The validated configuration of this process, read from process.env on first use. */
export function getRuntimeConfig(): RuntimeConfig {
  cached ??= readRuntimeConfig(process.env)
  return cached
}
