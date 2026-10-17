// The privilege matrix of the postgres-provision step, which must be all true after provisioning, and which `verify`
// runs again as the check postgres-privileges. One psql run as the admin role reads the facts of the server, the
// cluster and database libredb; each row is then a plain statement about the role privileges of
// docs/platform-studio-integration.md or Platform's PostgreSQL bootstrap, true or false.
import { z } from "zod";
import { ExitCode } from "../cli/exit-codes";
import { POSTGRES_NAMES } from "../state/immutable";
import type { Check } from "../verify/catalogue";
import { parseServerFacts, PostgresCheckError, serverFactsQuery, versionFailure, type ServerFacts } from "./checks";
import {
  APP_ROLES,
  BACKUP_ROLE,
  canGrantBackupRole,
  expectedRoles,
  FORBIDDEN_STUDIO_SETTING,
  ROLE_SETTINGS,
  ROLE_SPECS,
  STUDIO_SCHEMA,
  type AppRole,
  type ProvisionScope,
} from "./provision";
import { quoteLiteral, quotePsqlArgument } from "./quote";
import { parseResult, parseResults, resultQuery, SqlError, type PsqlLogin, type SqlRunner } from "./runner";

const adminFacts = z
  .object({
    name: z.string(),
    superuser: z.boolean(),
    createRole: z.boolean(),
    createDb: z.boolean(),
    /** pg_has_role(admin, 'pg_read_all_data', 'MEMBER WITH ADMIN OPTION'), always true for a superuser. */
    grantsReadAllData: z.boolean(),
  })
  .strict();

const roleFacts = z
  .object({
    name: z.string(),
    login: z.boolean(),
    superuser: z.boolean(),
    createDb: z.boolean(),
    createRole: z.boolean(),
    replication: z.boolean(),
    bypassRls: z.boolean(),
    connectionLimit: z.number().int(),
    readsAllData: z.boolean(),
    /** The role's settings in database libredb, as `name=value`. */
    databaseSettings: z.array(z.string()),
    /** The role's settings in every database, as `name=value`. */
    roleSettings: z.array(z.string()),
  })
  .strict();

const privilegeFlags = z.record(z.string(), z.boolean());

const databaseFacts = z
  .object({
    name: z.string(),
    owner: z.string(),
    encoding: z.string(),
    /** The privileges PUBLIC holds, from the ACL or the default ACL when none was set. */
    publicPrivileges: z.array(z.string()),
    /** has_database_privilege(role, database, 'CONNECT') of each role of the installation that exists. */
    connect: privilegeFlags,
    create: privilegeFlags,
  })
  .strict();

const schemaFacts = z
  .object({
    owner: z.string(),
    publicPrivileges: z.array(z.string()),
    /** has_schema_privilege(role, schema, 'USAGE') of each role of the installation that exists. */
    usage: privilegeFlags,
  })
  .strict();

const clusterFacts = z
  .object({ admin: adminFacts, roles: z.array(roleFacts), databases: z.array(databaseFacts) })
  .strict();

const libredbFacts = z.object({ schemas: z.record(z.string(), schemaFacts) }).strict();

export type AdminFacts = z.output<typeof adminFacts>;
export type RoleFacts = z.output<typeof roleFacts>;
export type DatabaseFacts = z.output<typeof databaseFacts>;
export type SchemaFacts = z.output<typeof schemaFacts>;

/** What one observation reads from the server, as the admin role. */
export interface PostgresFacts {
  server: ServerFacts;
  admin: AdminFacts;
  /** The roles of the installation's names that exist. */
  roles: RoleFacts[];
  /** The databases of the installation's names that exist. */
  databases: DatabaseFacts[];
  /** Schemas public and studio of database libredb, or null when the admin cannot connect to it, as before it exists. */
  schemas: Record<string, SchemaFacts> | null;
}

const list = (values: readonly string[]) => values.map(quoteLiteral).join(", ");

/**
 * The script that prints the facts as the results `server`, `cluster` and, when the admin can connect to database
 * libredb, `libredb`. The server facts come first, so a server too old for the later queries is still named.
 */
export function observationScript(): string {
  const roles = list(APP_ROLES.map((role) => ROLE_SPECS[role].name));
  const libredb = quoteLiteral(POSTGRES_NAMES.database);
  const cluster = resultQuery(
    "cluster",
    `jsonb_build_object(
  'admin', (SELECT jsonb_build_object('name', r.rolname, 'superuser', r.rolsuper, 'createRole', r.rolcreaterole,
      'createDb', r.rolcreatedb, 'grantsReadAllData', pg_has_role(r.oid, 'pg_read_all_data', 'MEMBER WITH ADMIN OPTION'))
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user),
  'roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', r.rolname, 'login', r.rolcanlogin,
      'superuser', r.rolsuper, 'createDb', r.rolcreatedb, 'createRole', r.rolcreaterole,
      'replication', r.rolreplication, 'bypassRls', r.rolbypassrls, 'connectionLimit', r.rolconnlimit,
      'readsAllData', pg_has_role(r.oid, 'pg_read_all_data', 'USAGE'),
      'databaseSettings', coalesce((SELECT s.setconfig FROM pg_catalog.pg_db_role_setting s
          JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase WHERE s.setrole = r.oid AND d.datname = ${libredb}), '{}'),
      'roleSettings', coalesce((SELECT s.setconfig FROM pg_catalog.pg_db_role_setting s
          WHERE s.setrole = r.oid AND s.setdatabase = 0), '{}')) ORDER BY r.rolname), '[]')
    FROM pg_catalog.pg_roles r WHERE r.rolname IN (${roles})),
  'databases', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', d.datname,
      'owner', pg_get_userbyid(d.datdba), 'encoding', pg_encoding_to_char(d.encoding),
      'publicPrivileges', (SELECT coalesce(jsonb_agg(a.privilege_type ORDER BY a.privilege_type), '[]')
          FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE a.grantee = 0),
      'connect', (SELECT coalesce(jsonb_object_agg(r.rolname, has_database_privilege(r.oid, d.oid, 'CONNECT')), '{}')
          FROM pg_catalog.pg_roles r WHERE r.rolname IN (${roles})),
      'create', (SELECT coalesce(jsonb_object_agg(r.rolname, has_database_privilege(r.oid, d.oid, 'CREATE')), '{}')
          FROM pg_catalog.pg_roles r WHERE r.rolname IN (${roles}))) ORDER BY d.datname), '[]')
    FROM pg_catalog.pg_database d WHERE d.datname IN (${list([POSTGRES_NAMES.database, POSTGRES_NAMES.keycloakDatabase])})))`,
  );
  const schemas = resultQuery(
    "libredb",
    `jsonb_build_object('schemas', (SELECT coalesce(jsonb_object_agg(n.nspname, jsonb_build_object(
      'owner', pg_get_userbyid(n.nspowner),
      'publicPrivileges', (SELECT coalesce(jsonb_agg(a.privilege_type ORDER BY a.privilege_type), '[]')
          FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a WHERE a.grantee = 0),
      'usage', (SELECT coalesce(jsonb_object_agg(r.rolname, has_schema_privilege(r.oid, n.oid, 'USAGE')), '{}')
          FROM pg_catalog.pg_roles r WHERE r.rolname IN (${roles})))), '{}')
    FROM pg_catalog.pg_namespace n WHERE n.nspname IN (${list(["public", STUDIO_SCHEMA])})))`,
  );
  return [
    serverFactsQuery(),
    cluster,
    `SELECT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = ${libredb}` +
      " AND has_database_privilege(oid, 'CONNECT')) AS libredb_connect \\gset",
    "\\if :libredb_connect",
    `\\connect ${quotePsqlArgument(POSTGRES_NAMES.database)}`,
    schemas,
    "\\endif",
    "",
  ].join("\n");
}

/** Reads the facts from the observation script's standard output. */
export function parseObservation(stdout: string): PostgresFacts {
  const results = parseResults(stdout);
  const result = (name: string) => {
    if (!results.has(name)) throw new Error(`the observation of PostgreSQL printed no ${name} result`);
    return results.get(name);
  };
  const server = parseServerFacts(result("server"));
  const cluster = parseResult(clusterFacts, result("cluster"), "cluster facts");
  const libredb = results.has("libredb") ? parseResult(libredbFacts, results.get("libredb"), "libredb facts") : undefined;
  return { server, ...cluster, schemas: libredb?.schemas ?? null };
}

/**
 * Runs the observation as the admin role. When psql fails on a server older than PostgreSQL 15, the error names the
 * version with exit 3, because the server facts were printed before the query that failed.
 */
export async function observePostgres(runner: SqlRunner, admin: PsqlLogin): Promise<PostgresFacts> {
  const result = await runner.run(admin, observationScript());
  if (result.exitCode !== 0) {
    const server = parseResults(result.stdout).get("server");
    const failure = server === undefined ? undefined : versionFailure(parseServerFacts(server));
    if (failure !== undefined) throw new PostgresCheckError([failure]);
    throw new SqlError(admin, result);
  }
  return parseObservation(result.stdout);
}

/** What the matrix expects: the Keycloak rows for a managed Keycloak, the backup rows when the admin can grant them. */
export function matrixExpectation(admin: AdminFacts, managedKeycloak: boolean): ProvisionScope {
  return { managedKeycloak, backupRole: canGrantBackupRole(admin) };
}

/**
 * What the matrix expects when an app role reads the facts, as with an external server whose admin credential the
 * installer does not hold: an app role cannot tell whether the admin could grant pg_read_all_data, so the backup rows
 * count when the backup role exists.
 */
export function appRoleExpectation(facts: PostgresFacts, managedKeycloak: boolean): ProvisionScope {
  return { managedKeycloak, backupRole: facts.roles.some((role) => role.name === BACKUP_ROLE) };
}

export interface MatrixRow {
  row: string;
  ok: boolean;
}

const ELEVATED = "SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS";

/** Evaluates every row of the matrix; a row about an object that does not exist is false. */
export function evaluateMatrix(facts: PostgresFacts, scope: ProvisionScope): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const add = (row: string, ok: boolean) => rows.push({ row, ok });
  const name = (role: AppRole) => ROLE_SPECS[role].name;
  const role = (key: AppRole) => facts.roles.find((entry) => entry.name === name(key));
  const database = (database: string) => facts.databases.find((entry) => entry.name === database);
  const roleRows = (key: AppRole) => {
    const found = role(key);
    const limit = ROLE_SPECS[key].connectionLimit;
    add(`role ${name(key)} exists and can log in`, found?.login === true);
    add(
      `${name(key)} has no ${ELEVATED}`,
      found !== undefined &&
        !(found.superuser || found.createDb || found.createRole || found.replication || found.bypassRls),
    );
    if (limit !== null) add(`${name(key)} has connection limit ${limit}`, found?.connectionLimit === limit);
  };

  for (const key of expectedRoles({ ...scope, backupRole: false })) roleRows(key);

  const libredbName = POSTGRES_NAMES.database;
  const libredb = database(libredbName);
  add(`database ${libredbName} is owned by ${name("owner")}`, libredb?.owner === name("owner"));
  add(`database ${libredbName} has encoding UTF8`, libredb?.encoding === "UTF8");
  add(`PUBLIC has no privilege on database ${libredbName}`, libredb?.publicPrivileges.length === 0);
  for (const key of ["owner", "platform", "studio"] as const) {
    add(`${name(key)} has CONNECT on database ${libredbName}`, libredb?.connect[name(key)] === true);
  }
  for (const key of ["platform", "studio"] as const) {
    add(`${name(key)} has no CREATE on database ${libredbName}`, libredb?.create[name(key)] === false);
  }
  if (scope.managedKeycloak) {
    add(`${name("keycloak")} has no CONNECT on database ${libredbName}`, libredb?.connect[name("keycloak")] === false);
  }

  const publicSchema = facts.schemas?.public;
  const studioSchema = facts.schemas?.[STUDIO_SCHEMA];
  add("PUBLIC has no privilege on schema public", publicSchema?.publicPrivileges.length === 0);
  add(`schema ${STUDIO_SCHEMA} is owned by ${name("studio")}`, studioSchema?.owner === name("studio"));
  add(`${name("platform")} has no USAGE on schema ${STUDIO_SCHEMA}`, studioSchema?.usage[name("platform")] === false);

  for (const setting of ROLE_SETTINGS) {
    const entry = `${setting.name}=${setting.value}`;
    add(
      `${name(setting.role)} has ${entry} in database ${libredbName}`,
      role(setting.role)?.databaseSettings.includes(entry) === true,
    );
  }
  const studio = role("studio");
  add(
    `${name("studio")} has no ${FORBIDDEN_STUDIO_SETTING}`,
    studio !== undefined &&
      ![...studio.databaseSettings, ...studio.roleSettings].some(
        (entry) => entry.split("=")[0] === FORBIDDEN_STUDIO_SETTING,
      ),
  );

  const keycloakName = POSTGRES_NAMES.keycloakDatabase;
  const keycloak = database(keycloakName);
  if (scope.managedKeycloak) {
    add(`database ${keycloakName} is owned by ${name("keycloak")}`, keycloak?.owner === name("keycloak"));
    add(`PUBLIC has no privilege on database ${keycloakName}`, keycloak?.publicPrivileges.length === 0);
  }

  if (scope.backupRole) {
    roleRows("backup");
    add(`${name("backup")} reads all data through pg_read_all_data`, role("backup")?.readsAllData === true);
    add(`${name("backup")} has CONNECT on database ${libredbName}`, libredb?.connect[name("backup")] === true);
    if (scope.managedKeycloak) {
      add(`${name("backup")} has CONNECT on database ${keycloakName}`, keycloak?.connect[name("backup")] === true);
    }
  }
  return rows;
}

export function falseRows(rows: readonly MatrixRow[]): string[] {
  return rows.filter((row) => !row.ok).map((row) => row.row);
}

/** The privilege matrix has false rows after provisioning. */
export class MatrixError extends Error {
  readonly exitCode = ExitCode.VerificationFailed;
  readonly rows: readonly string[];

  constructor(rows: readonly string[]) {
    super(["the PostgreSQL privilege matrix has false rows:", ...rows.map((row) => `  ${row}`)].join("\n"));
    this.name = "MatrixError";
    this.rows = rows;
  }
}

/** Throws MatrixError, exit 4, naming every false row. */
export function requireMatrix(rows: readonly MatrixRow[]): void {
  const failed = falseRows(rows);
  if (failed.length > 0) throw new MatrixError(failed);
}

/** How the check postgres-privileges reaches the server. */
export interface PrivilegeCheckContext {
  runner: SqlRunner;
  /**
   * The role that reads the facts of the matrix: the admin role of a managed server, or an app role of an external
   * one, whose admin credential the installer does not keep.
   */
  admin: PsqlLogin;
  /** Which kind of role `admin` is, which decides how the matrix expects the backup role. */
  observer: "admin" | "app-role";
  managedKeycloak: boolean;
}

/** The verify check that runs the privilege matrix again on the installed server. */
export const postgresPrivilegesCheck: Check<{ postgres: PrivilegeCheckContext }> = {
  id: "postgres-privileges",
  async run({ postgres }) {
    const facts = await observePostgres(postgres.runner, postgres.admin);
    const expectation =
      postgres.observer === "admin"
        ? matrixExpectation(facts.admin, postgres.managedKeycloak)
        : appRoleExpectation(facts, postgres.managedKeycloak);
    const failed = falseRows(evaluateMatrix(facts, expectation));
    return failed.length === 0 ? { passed: true } : { passed: false, cause: `false rows: ${failed.join("; ")}` };
  },
};
