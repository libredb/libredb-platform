/**
 * The database engines Platform governs: for each, the strict schema of its connection definition,
 * the strict schema of the credential set sealed for each access level, and the least-privilege guidance the
 * connection form shows.
 *
 * A definition holds only keys and values that the definition allowlist of Studio's contract admits,
 * so Studio never skips a connection Platform created, and only the keys the engine's provider in Studio reads.
 * engines.test.ts checks every schema against the vendored tests/fixtures/governance/contract-v1.json.
 * A credential set holds lsb1 plaintext keys that the provider reads, and is sealed, never stored.
 * The file engines sqlite, duckdb and libredb are never governed, so they are not offered.
 *
 * Nothing here runs only on the server, so the connection form can render the fields of each engine from it.
 */
import { z } from 'zod'
import type { CredentialSet, PlaintextKey } from '@/shared/lib/sealing/lsb1'

/** The engines Platform offers, by their Studio type id. */
export const ENGINE_IDS = ['postgres', 'mysql', 'mssql', 'oracle', 'mongodb', 'redis'] as const

export type EngineId = (typeof ENGINE_IDS)[number]

/** The values of `ssl.mode` in the definition allowlist. */
export const SSL_MODES = ['disable', 'require', 'verify-system', 'verify-ca', 'verify-full'] as const

/** A connection definition: the non-secret fields Studio reads from bridge.connections_v1. */
export type ConnectionDefinition = Readonly<Record<string, unknown>>

/** How to create a principal that can only read, shown with a confirmation the admin must give. */
export interface LeastPrivilegeGuidance {
  /** Statements in the engine's own language, with placeholders in angle brackets. */
  readonly statements: string
  /** What the statements cannot express, such as an engine that has no connection limit per principal. */
  readonly notes: readonly string[]
}

export interface EngineSpec {
  readonly id: EngineId
  readonly label: string
  readonly definition: z.ZodType<ConnectionDefinition>
  readonly credential: z.ZodType<CredentialSet>
  readonly guidance: LeastPrivilegeGuidance
}

const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*-----END [A-Z0-9 ]+-----/

/** A string field whose absence reads `<label> is required`, as its empty value does. */
function text(label: string) {
  return z.string({ error: (issue) => (issue.input === undefined ? `${label} is required` : `${label} must be text`) })
}

// Studio writes the host into a connection URL for MongoDB and Oracle, so a host is a DNS name or an IPv4 address, and
// nothing that could carry a port, a user, a path, a second host or URL options.
const host = text('Host')
  .trim()
  .min(1, 'Host is required')
  .max(253)
  .regex(/^[A-Za-z0-9_.-]+$/, 'must be a host name or an IPv4 address, without a port')

const port = z.number().int().min(1).max(65535)

const skipObjectScan = z.boolean()

const sqlDatabase = text('Database').trim().min(1, 'Database is required').max(128)

// A MongoDB database name goes into the path of the URL Studio builds, so it holds no URL syntax.
const mongoDatabase = z
  .string()
  .trim()
  .min(1, 'Database is required when set')
  .max(63)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be letters, digits, underscores or hyphens')

// Oracle's Easy Connect string ends with the service name after the host and port.
const serviceName = text('Service name')
  .trim()
  .min(1, 'Service name is required')
  .max(128)
  .regex(/^[A-Za-z0-9_.$#-]+$/, 'must be a service name such as ORCLPDB1')

const instanceName = z
  .string()
  .trim()
  .min(1, 'Instance name is required when set')
  .regex(/^[A-Za-z_#][A-Za-z0-9_$#]{0,15}$/, 'must be a SQL Server instance name of at most 16 characters')

// Redis selects a numbered database; Studio refuses any other value.
const redisDatabase = z.string().trim().regex(/^(0|[1-9][0-9]{0,4})$/, 'must be a database number such as 0')

const sslMode = z.enum(SSL_MODES, {
  error: (issue) =>
    issue.input === undefined ? 'SSL mode is required when SSL is set' : `must be one of ${SSL_MODES.join(', ')}`,
})

const caCert = z.string().trim().min(1).max(16384).regex(PEM, 'must be a PEM certificate')

// The TLS fields each provider in Studio reads: SQL Server reads the mode only, PostgreSQL, MySQL and Oracle derive
// certificate verification from the mode, and MongoDB and Redis also take an explicit rejectUnauthorized.
const sslModeOnly = z.strictObject({ mode: sslMode })
const sslWithCa = z.strictObject({ mode: sslMode, caCert: caCert.exactOptional() })
const sslWithCaAndVerification = z.strictObject({
  mode: sslMode,
  caCert: caCert.exactOptional(),
  rejectUnauthorized: z.boolean().exactOptional(),
})

const user = text('User').min(1, 'User is required').max(512)
const password = text('Password').min(1, 'Password is required').max(4096)
const clientCertificate = z.string().min(1).max(16384).regex(PEM, 'must be a PEM certificate')
const clientKey = z.string().min(1).max(16384).regex(PEM, 'must be a PEM private key')

type CredentialShape = { readonly [K in PlaintextKey]?: z.ZodType }

// The login of a principal; the user name lives in the envelope, never in the definition.
const LOGIN = { user, password } satisfies CredentialShape

// A TLS client certificate and its key, which Studio maps into ssl.clientCert and ssl.clientKey.
const TLS_CLIENT = {
  sslClientCert: clientCertificate.exactOptional(),
  sslClientKey: clientKey.exactOptional(),
} satisfies CredentialShape

function certificateWithKey(credential: { sslClientCert?: string; sslClientKey?: string }, ctx: z.RefinementCtx) {
  if ((credential.sslClientCert === undefined) === (credential.sslClientKey === undefined)) return
  const missing = credential.sslClientCert === undefined ? 'sslClientCert' : 'sslClientKey'
  ctx.addIssue({ code: 'custom', path: [missing], message: 'A TLS client certificate and its key are given together' })
}

const loginOnly = z.strictObject(LOGIN)
const loginWithClientCertificate = z.strictObject({ ...LOGIN, ...TLS_CLIENT }).superRefine(certificateWithKey)

const CONNECTION_LIMIT_NOTE =
  'Set <limit> to provider.poolMaxPerUser (3 by default) times the number of users granted the connection, and give the write login a connection limit of its own.'

export const ENGINES: Readonly<Record<EngineId, EngineSpec>> = {
  postgres: {
    id: 'postgres',
    label: 'PostgreSQL',
    // A definition without a database would open catalog sessions to every database the credential reaches.
    definition: z.strictObject({
      host,
      port: port.exactOptional(),
      database: sqlDatabase,
      skipObjectScan: skipObjectScan.exactOptional(),
      ssl: sslWithCa.exactOptional(),
    }),
    credential: loginWithClientCertificate,
    guidance: {
      statements: [
        "CREATE ROLE libredb_read LOGIN PASSWORD '<password>' CONNECTION LIMIT <limit>;",
        'GRANT CONNECT ON DATABASE <database> TO libredb_read;',
        'GRANT USAGE ON SCHEMA <schema> TO libredb_read;',
        'GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO libredb_read;',
        'ALTER DEFAULT PRIVILEGES IN SCHEMA <schema> GRANT SELECT ON TABLES TO libredb_read;',
        '-- PostgreSQL 14 and older let every role create objects in schema public.',
        'REVOKE CREATE ON SCHEMA public FROM PUBLIC;',
      ].join('\n'),
      notes: [
        'Never make libredb_read the owner of an object or a member of pg_write_all_data, either of which lets it write.',
        'ALTER DEFAULT PRIVILEGES covers the tables created later by the role that runs it, so run it as each role that creates tables in the schema.',
        CONNECTION_LIMIT_NOTE,
      ],
    },
  },
  mysql: {
    id: 'mysql',
    label: 'MySQL',
    definition: z.strictObject({
      host,
      port: port.exactOptional(),
      database: sqlDatabase,
      skipObjectScan: skipObjectScan.exactOptional(),
      ssl: sslWithCa.exactOptional(),
    }),
    credential: loginWithClientCertificate,
    guidance: {
      statements: [
        "CREATE USER 'libredb_read'@'%' IDENTIFIED BY '<password>' WITH MAX_USER_CONNECTIONS <limit>;",
        "GRANT SELECT, SHOW VIEW ON <database>.* TO 'libredb_read'@'%';",
      ].join('\n'),
      notes: [
        'Replace % with the address Studio connects from, and grant libredb_read no global privilege.',
        CONNECTION_LIMIT_NOTE,
      ],
    },
  },
  mssql: {
    id: 'mssql',
    label: 'SQL Server',
    // Studio's SQL Server provider refuses a connection without a database.
    definition: z.strictObject({
      host,
      port: port.exactOptional(),
      database: sqlDatabase,
      instanceName: instanceName.exactOptional(),
      skipObjectScan: skipObjectScan.exactOptional(),
      ssl: sslModeOnly.exactOptional(),
    }),
    credential: loginOnly,
    guidance: {
      statements: [
        "CREATE LOGIN libredb_read WITH PASSWORD = '<password>';",
        'USE <database>;',
        'CREATE USER libredb_read FOR LOGIN libredb_read;',
        'ALTER ROLE db_datareader ADD MEMBER libredb_read;',
      ].join('\n'),
      notes: [
        'SQL Server has no connection limit per login: limit the sessions of libredb_read with a logon trigger, or limit the users granted the connection.',
        CONNECTION_LIMIT_NOTE,
      ],
    },
  },
  oracle: {
    id: 'oracle',
    label: 'Oracle',
    // Studio would fall back to the service ORCL without a service name.
    definition: z.strictObject({
      host,
      port: port.exactOptional(),
      serviceName,
      skipObjectScan: skipObjectScan.exactOptional(),
      ssl: sslWithCa.exactOptional(),
    }),
    credential: loginWithClientCertificate,
    guidance: {
      statements: [
        'CREATE PROFILE libredb_read_profile LIMIT SESSIONS_PER_USER <limit>;',
        'CREATE USER libredb_read IDENTIFIED BY "<password>" PROFILE libredb_read_profile;',
        'GRANT CREATE SESSION TO libredb_read;',
        'GRANT READ ON <schema>.<table> TO libredb_read;',
      ].join('\n'),
      notes: [
        'Grant READ on each table or view the users may query, and never a system privilege such as SELECT ANY TABLE.',
        'SESSIONS_PER_USER applies only while the initialization parameter RESOURCE_LIMIT is TRUE.',
        CONNECTION_LIMIT_NOTE,
      ],
    },
  },
  mongodb: {
    id: 'mongodb',
    label: 'MongoDB',
    definition: z.strictObject({
      host,
      port: port.exactOptional(),
      database: mongoDatabase.exactOptional(),
      authSource: mongoDatabase.exactOptional(),
      skipObjectScan: skipObjectScan.exactOptional(),
      ssl: sslWithCaAndVerification.exactOptional(),
    }),
    credential: loginWithClientCertificate,
    guidance: {
      statements: [
        'use admin',
        'db.createUser({',
        '  user: "libredb_read",',
        '  pwd: "<password>",',
        '  roles: [{ role: "read", db: "<database>" }]',
        '})',
      ].join('\n'),
      notes: [
        'Set authSource to admin in the definition, the database the user is created in.',
        'MongoDB has no connection limit per user: net.maxIncomingConnections limits the connections of the whole server.',
      ],
    },
  },
  redis: {
    id: 'redis',
    label: 'Redis',
    definition: z.strictObject({
      host,
      port: port.exactOptional(),
      database: redisDatabase.exactOptional(),
      skipObjectScan: skipObjectScan.exactOptional(),
      ssl: sslWithCaAndVerification.exactOptional(),
    }),
    credential: loginWithClientCertificate,
    guidance: {
      statements: 'ACL SETUSER libredb_read on ><password> ~* -@all +@read +ping +info',
      notes: [
        'Add +select when the definition names a database other than 0.',
        'Redis has no connection limit per user: maxclients limits the connections of the whole server.',
      ],
    },
  },
}

export function isEngineId(value: string): value is EngineId {
  return (ENGINE_IDS as readonly string[]).includes(value)
}

export { hostSummary } from '@/shared/lib/connection-host-summary'
