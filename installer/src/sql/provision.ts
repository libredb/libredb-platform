// Provisioning of the postgres-provision step: the roles, databases, schema and role settings of Platform's
// PostgreSQL bootstrap (docker/postgres/bootstrap.psql), plus database keycloak for a managed Keycloak and the backup
// role for customer-run backups, rendered as one psql script. Every role password reaches the script as a
// SCRAM-SHA-256 verifier in a psql variable, so no cleartext password reaches the server or its logs, and every create
// is guarded by an existence check, so the script converges whatever it finds.
import { randomBytes } from "node:crypto";
import { ExitCode } from "../cli/exit-codes";
import type { Action } from "../engine/step";
import { scramSha256Verifier } from "../secrets/scram";
import { POSTGRES_NAMES } from "../state/immutable";
import type { OwnershipRecord } from "../state/store";
import { adminCheckFailures, PostgresCheckError, serverCheckFailures, type ConnectionBudget } from "./checks";
import type { AdminFacts, MatrixRow, PostgresFacts } from "./matrix";
import { quoteIdent, quoteLiteral, quotePsqlArgument } from "./quote";

/** The roles provisioning creates, in the order it creates them. */
export const APP_ROLES = ["owner", "platform", "studio", "keycloak", "backup"] as const;

export type AppRole = (typeof APP_ROLES)[number];

export interface RoleSpec {
  name: string;
  /** The CONNECTION LIMIT of the connection budget in docs/deploy/platform-runtime.md, or null for none. */
  connectionLimit: number | null;
  /** The generated secret that holds the role's password. */
  secret: string;
  /** The database the role logs in to when the installer tries its stored password. */
  database: string;
}

/** The role for customer-run backups, which reads every table through pg_read_all_data. */
export const BACKUP_ROLE = "libredb_backup";

export const ROLE_SPECS: Readonly<Record<AppRole, RoleSpec>> = {
  owner: {
    name: POSTGRES_NAMES.roles.owner,
    connectionLimit: 5,
    secret: "postgres-owner-password",
    database: POSTGRES_NAMES.database,
  },
  platform: {
    name: POSTGRES_NAMES.roles.platform,
    connectionLimit: 25,
    secret: "postgres-platform-password",
    database: POSTGRES_NAMES.database,
  },
  studio: {
    name: POSTGRES_NAMES.roles.studio,
    connectionLimit: 30,
    secret: "postgres-studio-password",
    database: POSTGRES_NAMES.database,
  },
  keycloak: {
    name: POSTGRES_NAMES.roles.keycloak,
    connectionLimit: 25,
    secret: "postgres-keycloak-password",
    database: POSTGRES_NAMES.keycloakDatabase,
  },
  backup: {
    name: BACKUP_ROLE,
    connectionLimit: null,
    secret: "postgres-backup-password",
    database: POSTGRES_NAMES.database,
  },
};

/** The schema Studio owns in database libredb. */
export const STUDIO_SCHEMA = "studio";

/** The role settings of the bootstrap in database libredb, in its order. */
export const ROLE_SETTINGS: readonly { role: AppRole; name: string; value: string }[] = [
  { role: "owner", name: "search_path", value: "platform" },
  { role: "platform", name: "search_path", value: "platform" },
  { role: "studio", name: "search_path", value: "studio" },
  { role: "studio", name: "statement_timeout", value: "30s" },
  { role: "studio", name: "idle_in_transaction_session_timeout", value: "60s" },
  { role: "platform", name: "idle_in_transaction_session_timeout", value: "60s" },
];

/** Never set for libredb_studio, because it would end Studio's LISTEN connection. */
export const FORBIDDEN_STUDIO_SETTING = "idle_session_timeout";

/** What this installation creates on the server besides the bootstrap. */
export interface ProvisionScope {
  /** Role libredb_keycloak and database keycloak, for a managed Keycloak. */
  managedKeycloak: boolean;
  /** Role libredb_backup, created when the admin role can grant pg_read_all_data. */
  backupRole: boolean;
}

export function expectedRoles(scope: ProvisionScope): AppRole[] {
  return APP_ROLES.filter(
    (role) => (role !== "keycloak" || scope.managedKeycloak) && (role !== "backup" || scope.backupRole),
  );
}

export function expectedDatabases(scope: ProvisionScope): string[] {
  return scope.managedKeycloak ? [POSTGRES_NAMES.database, POSTGRES_NAMES.keycloakDatabase] : [POSTGRES_NAMES.database];
}

/** The generated secrets that hold the role passwords; the Keycloak one only for a managed Keycloak. */
export function roleSecretNames(managedKeycloak: boolean): string[] {
  return APP_ROLES.filter((role) => role !== "keycloak" || managedKeycloak).map((role) => ROLE_SPECS[role].secret);
}

/** Whether the admin role can grant pg_read_all_data, which the backup role needs. */
export function canGrantBackupRole(admin: AdminFacts): boolean {
  return admin.superuser || admin.grantsReadAllData;
}

/** The warning for the report when the admin role cannot create the backup role. */
export function backupWarning(admin: AdminFacts): string | undefined {
  if (canGrantBackupRole(admin)) return undefined;
  return (
    `role ${BACKUP_ROLE} was not created, because the admin role ${admin.name} is neither a superuser nor holds ` +
    "pg_read_all_data WITH ADMIN OPTION; grant it that option and apply again to get a backup role for " +
    "customer-run backups"
  );
}

/** A SCRAM-SHA-256 verifier per given password, each with a fresh random 16-byte salt. */
export function roleVerifiers(
  passwords: Readonly<Partial<Record<AppRole, string>>>,
  salt: () => Uint8Array = () => randomBytes(16),
): Partial<Record<AppRole, string>> {
  const verifiers: Partial<Record<AppRole, string>> = {};
  for (const role of APP_ROLES) {
    const password = passwords[role];
    if (password !== undefined) verifiers[role] = scramSha256Verifier(password, salt());
  }
  return verifiers;
}

export interface ProvisionScriptInput {
  /** The SCRAM verifier of the password of every role the script may create. */
  verifiers: Readonly<Partial<Record<AppRole, string>>>;
  managedKeycloak: boolean;
  /** Existing roles whose stored password failed to log in, which get their verifier again. */
  resetPasswords: readonly AppRole[];
}

const ELEVATED_ATTRIBUTES = "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

const passwordVariable = (role: AppRole) => `${role}_pw`;

const ident = (role: AppRole) => quoteIdent(ROLE_SPECS[role].name);

function connectionLimitClause(spec: RoleSpec): string {
  return spec.connectionLimit === null ? "" : ` CONNECTION LIMIT ${spec.connectionLimit}`;
}

// The clauses that restore a drifted attribute, each next to the column that shows the drift.
const DRIFT_CLAUSES = [
  ["NOT rolcanlogin", "LOGIN"],
  ["rolsuper", "NOSUPERUSER"],
  ["rolcreatedb", "NOCREATEDB"],
  ["rolcreaterole", "NOCREATEROLE"],
  ["rolreplication", "NOREPLICATION"],
  ["rolbypassrls", "NOBYPASSRLS"],
] as const;

// CREATE ROLE when the role is missing, and ALTER ROLE only when its attributes drifted, so a converged server runs no
// ALTER ROLE. The ALTER ROLE names only the drifted attributes, because PostgreSQL lets only a superuser name SUPERUSER,
// REPLICATION or BYPASSRLS there, even to restore the value they already have, and so an admin with CREATEROLE repairs
// every other drift. format() quotes the name as an identifier and the verifier as a literal on the server.
function roleStatements(role: AppRole): string[] {
  const spec = ROLE_SPECS[role];
  const name = quoteLiteral(spec.name);
  const limit = connectionLimitClause(spec);
  const create = quoteLiteral(`CREATE ROLE %I LOGIN PASSWORD %L ${ELEVATED_ATTRIBUTES}${limit}`);
  const elevated = "rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls";
  const limitHolds = spec.connectionLimit === null ? "" : ` AND rolconnlimit = ${spec.connectionLimit}`;
  const drift = [
    ...DRIFT_CLAUSES,
    ...(spec.connectionLimit === null ? [] : [[`rolconnlimit <> ${spec.connectionLimit}`, limit.trim()] as const]),
  ].map(([column, clause]) => `CASE WHEN ${column} THEN ${quoteLiteral(` ${clause}`)} ELSE '' END`);
  return [
    `SELECT format(${create}, ${name}, :'${passwordVariable(role)}')`,
    `  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${name}) \\gexec`,
    `SELECT format('ALTER ROLE %I', rolname) || ${drift.join(" || ")} FROM pg_catalog.pg_roles`,
    `  WHERE rolname = ${name} AND NOT (rolcanlogin AND NOT (${elevated})${limitHolds}) \\gexec`,
  ];
}

function databaseStatement(database: string, owner: AppRole): string[] {
  const name = quoteLiteral(database);
  const create = quoteLiteral("CREATE DATABASE %I OWNER %I ENCODING 'UTF8' TEMPLATE template0");
  return [
    `SELECT format(${create}, ${name}, ${quoteLiteral(ROLE_SPECS[owner].name)})`,
    `  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = ${name}) \\gexec`,
  ];
}

const roleOid = (role: AppRole) =>
  `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${quoteLiteral(ROLE_SPECS[role].name)})`;

const libredbOid = `(SELECT oid FROM pg_catalog.pg_database WHERE datname = ${quoteLiteral(POSTGRES_NAMES.database)})`;

// ALTER ROLE ... IN DATABASE ... SET only for a setting that is missing or holds another value.
function settingStatements(): string[] {
  const values = ROLE_SETTINGS.map(
    (setting) =>
      `(${quoteLiteral(ROLE_SPECS[setting.role].name)}, ${quoteLiteral(setting.name)}, ${quoteLiteral(setting.value)})`,
  );
  const studio = quoteLiteral(ROLE_SPECS.studio.name);
  const libredb = quoteLiteral(POSTGRES_NAMES.database);
  const set = quoteLiteral("ALTER ROLE %I IN DATABASE %I SET %I = %L");
  const resetInDatabase = quoteLiteral(`ALTER ROLE %I IN DATABASE %I RESET ${FORBIDDEN_STUDIO_SETTING}`);
  const reset = quoteLiteral(`ALTER ROLE %I RESET ${FORBIDDEN_STUDIO_SETTING}`);
  const hasForbidden = (database: string) =>
    "EXISTS (SELECT FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS entry" +
    ` WHERE s.setrole = ${roleOid("studio")} AND s.setdatabase = ${database}` +
    ` AND split_part(entry, '=', 1) = ${quoteLiteral(FORBIDDEN_STUDIO_SETTING)})`;
  return [
    `SELECT format(${set}, wanted.role, ${libredb}, wanted.name, wanted.value)`,
    `  FROM (VALUES ${values.join(",\n              ")}) AS wanted(role, name, value)`,
    "  WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_db_role_setting s",
    "    WHERE s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = wanted.role)",
    `      AND s.setdatabase = ${libredbOid}`,
    "      AND wanted.name || '=' || wanted.value = ANY (s.setconfig)) \\gexec",
    `-- Never set ${FORBIDDEN_STUDIO_SETTING} for ${ROLE_SPECS.studio.name}: it would end Studio's LISTEN connection.`,
    `SELECT format(${resetInDatabase}, ${studio}, ${libredb})`,
    `  WHERE ${hasForbidden(libredbOid)} \\gexec`,
    `SELECT format(${reset}, ${studio})`,
    `  WHERE ${hasForbidden("0")} \\gexec`,
  ];
}

/**
 * Renders the provisioning script for psql, run as the admin role connected to its own database.
 * A superuser runs the owner-only statements under SET ROLE as well, so both paths give the same ACLs. A non-superuser
 * admin with CREATEROLE and CREATEDB first grants itself the roles it switches to (WITH SET TRUE on PostgreSQL 16 and
 * later), and creates schema studio as libredb_studio through a CREATE grant on libredb that the script revokes.
 */
export function renderProvisionScript(input: ProvisionScriptInput): string {
  const roles = expectedRoles({ managedKeycloak: input.managedKeycloak, backupRole: true });
  for (const role of roles) {
    if (input.verifiers[role] === undefined) throw new Error(`no SCRAM verifier for role ${ROLE_SPECS[role].name}`);
  }
  const appRoles = roles.filter((role) => role !== "backup");
  const switchedTo = appRoles.filter((role) => role === "owner" || role === "studio" || role === "keycloak");
  const libredb = quoteIdent(POSTGRES_NAMES.database);
  const keycloak = quoteIdent(POSTGRES_NAMES.keycloakDatabase);
  const studioSchema = quoteLiteral(STUDIO_SCHEMA);
  const lines = [
    "-- Rendered by libredb-installer: Platform's PostgreSQL bootstrap, run as the admin role.",
    "-- Every password is a SCRAM-SHA-256 verifier in a psql variable, so no cleartext password reaches the server.",
    "\\set ON_ERROR_STOP on",
    ...roles.map((role) => `\\set ${passwordVariable(role)} ${quotePsqlArgument(input.verifiers[role] as string)}`),
    "SELECT current_setting('server_version_num')::int >= 160000 AS pg16, NOT r.rolsuper AS grant_self,",
    "       pg_has_role(r.oid, 'pg_read_all_data', 'MEMBER WITH ADMIN OPTION') AS backup_role",
    "  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user \\gset",
    "",
    "-- Roles: created when missing, their attributes restored only when they drifted.",
    ...appRoles.flatMap(roleStatements),
    "\\if :backup_role",
    ...roleStatements("backup"),
    `GRANT pg_read_all_data TO ${ident("backup")};`,
    "\\endif",
    ...input.resetPasswords.map((role) => `ALTER ROLE ${ident(role)} PASSWORD :'${passwordVariable(role)}';`),
    "",
    "-- A non-superuser admin grants itself the roles it switches to with SET ROLE.",
    "\\if :grant_self",
    "\\if :pg16",
    `GRANT ${switchedTo.map(ident).join(", ")} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;`,
    "\\else",
    `GRANT ${switchedTo.map(ident).join(", ")} TO CURRENT_USER;`,
    "\\endif",
    "\\endif",
    "",
    "-- Databases",
    ...databaseStatement(POSTGRES_NAMES.database, "owner"),
  ];
  if (input.managedKeycloak) {
    lines.push(
      ...databaseStatement(POSTGRES_NAMES.keycloakDatabase, "keycloak"),
      `SET ROLE ${ident("keycloak")};`,
      `REVOKE ALL ON DATABASE ${keycloak} FROM PUBLIC;`,
      "\\if :backup_role",
      `GRANT CONNECT ON DATABASE ${keycloak} TO ${ident("backup")};`,
      "\\endif",
      "RESET ROLE;",
    );
  }
  lines.push(
    "",
    `\\connect ${quotePsqlArgument(POSTGRES_NAMES.database)}`,
    `SET ROLE ${ident("owner")};`,
    `REVOKE ALL ON DATABASE ${libredb} FROM PUBLIC;`,
    `GRANT CONNECT ON DATABASE ${libredb} TO ${(["owner", "platform", "studio"] as const).map(ident).join(", ")};`,
    "\\if :backup_role",
    `GRANT CONNECT ON DATABASE ${libredb} TO ${ident("backup")};`,
    "\\endif",
    "-- Beyond the bootstrap, which starts from nothing: revoke what a drifted server granted the app roles.",
    `REVOKE CREATE ON DATABASE ${libredb} FROM ${ident("platform")};`,
    ...(input.managedKeycloak ? [`REVOKE ALL ON DATABASE ${libredb} FROM ${ident("keycloak")};`] : []),
    "REVOKE ALL ON SCHEMA public FROM PUBLIC;",
    `SELECT NOT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = ${studioSchema}) AS create_studio_schema \\gset`,
    "\\if :create_studio_schema",
    `GRANT CREATE ON DATABASE ${libredb} TO ${ident("studio")};`,
    `SET ROLE ${ident("studio")};`,
    `CREATE SCHEMA ${quoteIdent(STUDIO_SCHEMA)} AUTHORIZATION ${ident("studio")};`,
    `SET ROLE ${ident("owner")};`,
    "\\endif",
    `REVOKE CREATE ON DATABASE ${libredb} FROM ${ident("studio")};`,
    `SET ROLE ${ident("studio")};`,
    `REVOKE ALL ON SCHEMA ${quoteIdent(STUDIO_SCHEMA)} FROM ${ident("platform")};`,
    "RESET ROLE;",
    "",
    "-- Role settings, each set only when it is missing or differs.",
    ...settingStatements(),
    "",
  );
  return lines.join("\n");
}

export interface DbaScriptInput {
  /** The stored password of every role the script may create. */
  passwords: Readonly<Partial<Record<AppRole, string>>>;
  managedKeycloak: boolean;
  /** The external server, which the header names for the DBA. */
  server: { host: string; port: number };
  /** The salt of each verifier, a fresh random 16 bytes by default. */
  salt?: () => Uint8Array;
}

/**
 * The script `db-script` writes for a DBA when postgres.external.provisioning is manual: the provisioning script of
 * the bootstrap with every password as a SCRAM-SHA-256 verifier of the one the installer stored, so no cleartext
 * password leaves the installer. It sets the password of every role the installation logs in as, so running it again
 * converges a server where an earlier run created those roles; the backup role keeps the password it was created with.
 */
export function renderDbaScript(input: DbaScriptInput): string {
  const roles = expectedRoles({ managedKeycloak: input.managedKeycloak, backupRole: true });
  for (const role of roles) {
    if (input.passwords[role] === undefined) throw new Error(`no stored password for role ${ROLE_SPECS[role].name}`);
  }
  const { host, port } = input.server;
  const header = [
    `-- LibreDB provisioning of the external PostgreSQL server ${host}:${port}, written by libredb-installer db-script.`,
    "-- Run it once with psql as a superuser or as a role with CREATEROLE and CREATEDB, such as:",
    `--   psql "host=${host} port=${port} dbname=postgres user=<admin> sslmode=verify-full sslrootcert=<CA file>" -f <this file>`,
    "-- Running it again converges the server and sets the password of every role the installation logs in as again.",
    "",
  ];
  const script = renderProvisionScript({
    verifiers: roleVerifiers(input.passwords, input.salt),
    managedKeycloak: input.managedKeycloak,
    resetPasswords: roles.filter((role) => role !== "backup"),
  });
  return [...header, script].join("\n");
}

/**
 * An external server with provisioning manual that is not provisioned as the DBA script of db-script provisions it,
 * named by every problem the app roles found. The installer cannot fix it, because it holds no admin credential.
 */
export class ManualProvisionError extends Error {
  readonly exitCode = ExitCode.PreflightFailed;
  readonly problems: readonly string[];

  constructor(server: { host: string; port: number }, problems: readonly string[]) {
    super(
      [
        `the external PostgreSQL server ${server.host}:${server.port} is not provisioned as the DBA script of db-script provisions it:`,
        ...problems.map((problem) => `  ${problem}`),
        "Run 'libredb-installer db-script -c <libredb.yaml> -o <file>', have a DBA run that script with psql as a " +
          "superuser or a role with CREATEROLE and CREATEDB, then apply again.",
      ].join("\n"),
    );
    this.name = "ManualProvisionError";
    this.problems = problems;
  }
}

export type PostgresObjectKind = "postgres-role" | "postgres-database";

/** A role or database this installation creates and records in the state. */
export interface PostgresObject {
  kind: PostgresObjectKind;
  name: string;
}

/** The step that records the PostgreSQL objects of an installation. */
export const PROVISION_STEP = "postgres-provision";

export function expectedObjects(scope: ProvisionScope): PostgresObject[] {
  return [
    ...expectedRoles(scope).map((role): PostgresObject => ({ kind: "postgres-role", name: ROLE_SPECS[role].name })),
    ...expectedDatabases(scope).map((name): PostgresObject => ({ kind: "postgres-database", name })),
  ];
}

/** The objects of this installation that exist on the server. */
export function existingObjects(facts: PostgresFacts, scope: ProvisionScope): PostgresObject[] {
  const roles = new Set(facts.roles.map((role) => role.name));
  const databases = new Set(facts.databases.map((database) => database.name));
  return expectedObjects(scope).filter((object) => (object.kind === "postgres-role" ? roles : databases).has(object.name));
}

export function ownershipRecords(objects: readonly PostgresObject[]): OwnershipRecord[] {
  return objects.map((object) => ({ kind: object.kind, name: object.name, step: PROVISION_STEP }));
}

function describeObjects(objects: readonly PostgresObject[]): string {
  const names = objects.map((object) => `${object.kind === "postgres-role" ? "role" : "database"} ${object.name}`);
  return names.length === 1 ? (names[0] as string) : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A role or database of the installation's names exists, but the state does not record it as created here. */
export class OwnershipConflictError extends Error {
  readonly exitCode = ExitCode.PreflightFailed;
  readonly objects: readonly PostgresObject[];

  constructor(objects: readonly PostgresObject[]) {
    const one = objects.length === 1;
    super(
      `${describeObjects(objects)} ${one ? "exists" : "exist"} on the PostgreSQL server, but this installation did not ` +
        `create ${one ? "it" : "them"}; drop or rename ${one ? "it" : "them"}, because the installer never adopts ` +
        "objects it did not create",
    );
    this.name = "OwnershipConflictError";
    this.objects = objects;
  }
}

/** Throws OwnershipConflictError naming every existing object that the state does not record as provisioned here. */
export function checkOwnership(existing: readonly PostgresObject[], ownership: readonly OwnershipRecord[]): void {
  const unrecorded = existing.filter(
    (object) =>
      !ownership.some(
        (record) => record.kind === object.kind && record.name === object.name && record.step === PROVISION_STEP,
      ),
  );
  if (unrecorded.length > 0) throw new OwnershipConflictError(unrecorded);
}

export type ProvisionAction =
  | (Action & { kind: "create-role"; role: AppRole })
  | (Action & { kind: "create-database"; database: string })
  | (Action & { kind: "password"; role: AppRole })
  | (Action & { kind: "converge"; rows: string[] });

export interface ProvisionInput {
  facts: PostgresFacts;
  /** The privilege matrix evaluated on the facts. */
  rows: readonly MatrixRow[];
  /** For each role of the installation that exists, whether it logged in with its stored password. */
  logins: Readonly<Partial<Record<AppRole, boolean>>>;
  ownership: readonly OwnershipRecord[];
  expectation: ProvisionScope;
  budget: ConnectionBudget;
}

/**
 * Plans provisioning from what the server holds. The server checks and the admin role's attributes come first and then
 * the ownership check, all with exit 3. A converged server, whose matrix holds and whose roles log in with their stored
 * passwords, plans nothing, so an unchanged re-run executes no statement at all.
 */
export function planProvision(input: ProvisionInput): ProvisionAction[] {
  const failures = [...serverCheckFailures(input.facts.server, input.budget), ...adminCheckFailures(input.facts.admin)];
  if (failures.length > 0) throw new PostgresCheckError(failures);
  const existing = existingObjects(input.facts, input.expectation);
  checkOwnership(existing, input.ownership);
  const exists = (kind: PostgresObjectKind, name: string) =>
    existing.some((object) => object.kind === kind && object.name === name);
  const roles = expectedRoles(input.expectation);
  const actions: ProvisionAction[] = [];
  for (const role of roles) {
    const name = ROLE_SPECS[role].name;
    if (!exists("postgres-role", name)) actions.push({ kind: "create-role", role, summary: `create role ${name}` });
  }
  for (const database of expectedDatabases(input.expectation)) {
    if (!exists("postgres-database", database)) {
      actions.push({ kind: "create-database", database, summary: `create database ${database}` });
    }
  }
  for (const role of roles) {
    const name = ROLE_SPECS[role].name;
    if (exists("postgres-role", name) && input.logins[role] !== true) {
      actions.push({
        kind: "password",
        role,
        summary: `set the password of role ${name}, which does not log in with the stored one`,
      });
    }
  }
  const rows = input.rows.filter((row) => !row.ok).map((row) => row.row);
  if (rows.length > 0) {
    const creates = actions.some((action) => action.kind === "create-role" || action.kind === "create-database");
    actions.push({
      kind: "converge",
      rows,
      summary: creates
        ? "grant the privileges and set the schema and role settings of Platform's PostgreSQL bootstrap"
        : `converge Platform's PostgreSQL bootstrap, where these rows are false: ${rows.join("; ")}`,
    });
  }
  return actions;
}
