// The server checks for the PostgreSQL server of the installation: PostgreSQL 15 or newer, the primary rather than
// a standby, a max_connections that covers the connection budget of docs/deploy/platform-runtime.md, an admin role
// that can run Platform's PostgreSQL bootstrap, and a LISTEN/NOTIFY round trip as libredb_studio on the host and port
// that the Studio URLs use. A failed check exits 3.
import { z } from "zod";
import { ExitCode } from "../cli/exit-codes";
import { quoteIdent, quoteLiteral } from "./quote";
import { parseResult, resultQuery, type PsqlLogin, type PsqlResult } from "./runner";

/** PostgreSQL 15 is the oldest supported server, because the bridge views need the security_invoker reloption. */
export const MIN_SERVER_VERSION_NUM = 150000;

/** The pool size the installer gives a managed Keycloak, KC_DB_POOL_MAX_SIZE. */
export const KEYCLOAK_DB_POOL_MAX_SIZE = 20;

/**
 * The connections one replica of each app opens at most, and the headroom on top of them, as the connection budget
 * of docs/deploy/platform-runtime.md counts them. A Platform replica holds Prisma's pool of 10 and a scheduler lock
 * pool of one connection per task plus one, 4 with its three tasks.
 */
export const PLATFORM_CONNECTIONS_PER_REPLICA = 14;
export const STUDIO_CONNECTIONS_PER_REPLICA = 10;
export const CONNECTION_HEADROOM = 15;

/**
 * v1 runs one replica of each app, because Studio keeps transaction ownership, rate limits and providers in process
 * memory.
 */
export const V1_REPLICAS = { platformReplicas: 1, studioReplicas: 1 } as const;

/** What the connection budget counts besides the server's reserved connections. */
export interface ConnectionBudget {
  /** Whether Keycloak keeps its database on this server, so that its pool counts. */
  managedKeycloak: boolean;
  platformReplicas: number;
  studioReplicas: number;
}

const serverFacts = z
  .object({
    /** server_version, such as `18.6 (Debian 18.6-1.pgdg13+2)`. */
    version: z.string(),
    versionNum: z.number().int(),
    inRecovery: z.boolean(),
    maxConnections: z.number().int(),
    superuserReservedConnections: z.number().int(),
    /** reserved_connections, which PostgreSQL 16 added; null on an older server. */
    reservedConnections: z.number().int().nullable(),
  })
  .strict();

export type ServerFacts = z.output<typeof serverFacts>;

/** The query that prints the server facts as the result `server`. It runs on any version, so an old one can be named. */
export function serverFactsQuery(): string {
  return resultQuery(
    "server",
    `jsonb_build_object(
  'version', current_setting('server_version'),
  'versionNum', current_setting('server_version_num')::int,
  'inRecovery', pg_is_in_recovery(),
  'maxConnections', current_setting('max_connections')::int,
  'superuserReservedConnections', current_setting('superuser_reserved_connections')::int,
  'reservedConnections', current_setting('reserved_connections', true)::int)`,
  );
}

export function parseServerFacts(value: unknown): ServerFacts {
  return parseResult(serverFacts, value, "server facts");
}

/** The connections the installation needs, `reserved + Keycloak pool + Platform x 14 + Studio x 10 + 15`, with its terms. */
export function connectionBudget(facts: ServerFacts, budget: ConnectionBudget): { required: number; terms: string } {
  const reserved = facts.superuserReservedConnections + (facts.reservedConnections ?? 0);
  const replicas = (count: number, app: string) => `${count} ${app} replica${count === 1 ? "" : "s"}`;
  const keycloak = budget.managedKeycloak ? KEYCLOAK_DB_POOL_MAX_SIZE : 0;
  const terms = [
    `${reserved} reserved`,
    ...(budget.managedKeycloak ? [`${KEYCLOAK_DB_POOL_MAX_SIZE} for the Keycloak pool`] : []),
    `${replicas(budget.platformReplicas, "Platform")} x ${PLATFORM_CONNECTIONS_PER_REPLICA}`,
    `${replicas(budget.studioReplicas, "Studio")} x ${STUDIO_CONNECTIONS_PER_REPLICA}`,
    `${CONNECTION_HEADROOM}`,
  ];
  const required =
    reserved +
    keycloak +
    budget.platformReplicas * PLATFORM_CONNECTIONS_PER_REPLICA +
    budget.studioReplicas * STUDIO_CONNECTIONS_PER_REPLICA +
    CONNECTION_HEADROOM;
  return { required, terms: terms.join(" + ") };
}

/** The version failure alone, which names a server too old to answer the other queries. */
export function versionFailure(facts: ServerFacts): string | undefined {
  if (facts.versionNum >= MIN_SERVER_VERSION_NUM) return undefined;
  return `the server runs PostgreSQL ${facts.version}, and LibreDB needs 15 or newer`;
}

/** One line per failed server check, empty when the server passes them all. */
export function serverCheckFailures(facts: ServerFacts, budget: ConnectionBudget): string[] {
  const failures: string[] = [];
  const version = versionFailure(facts);
  if (version !== undefined) failures.push(version);
  if (facts.inRecovery) {
    failures.push("the server is a standby (pg_is_in_recovery() is true), and the installation needs the primary");
  }
  const { required, terms } = connectionBudget(facts, budget);
  if (facts.maxConnections < required) {
    failures.push(`max_connections is ${facts.maxConnections}, below the connection budget of ${required}: ${terms}`);
  }
  return failures;
}

/** The PostgreSQL server fails a check of the installation. */
export class PostgresCheckError extends Error {
  readonly exitCode = ExitCode.PreflightFailed;
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    const lines = failures.map((failure) => `  ${failure}`);
    super(["the PostgreSQL server fails the checks of the installation:", ...lines].join("\n"));
    this.name = "PostgresCheckError";
    this.failures = failures;
  }
}

/** Throws PostgresCheckError naming every failed server check. */
export function checkServer(facts: ServerFacts, budget: ConnectionBudget): void {
  const failures = serverCheckFailures(facts, budget);
  if (failures.length > 0) throw new PostgresCheckError(failures);
}

/** The attributes of the role that provisions the server, as pg_roles reports them for current_user. */
export interface AdminAttributes {
  name: string;
  superuser: boolean;
  createRole: boolean;
  createDb: boolean;
}

/** One line when the admin role can run the bootstrap neither as a superuser nor with CREATEROLE and CREATEDB. */
export function adminCheckFailures(admin: AdminAttributes): string[] {
  if (admin.superuser) return [];
  const missing = [...(admin.createRole ? [] : ["CREATEROLE"]), ...(admin.createDb ? [] : ["CREATEDB"])];
  if (missing.length === 0) return [];
  return [
    `the admin role ${admin.name} lacks ${missing.join(" and ")}, and provisioning needs SUPERUSER, or CREATEROLE and ` +
      "CREATEDB",
  ];
}

/** Throws PostgresCheckError, exit 3, naming the attributes the admin role lacks. */
export function checkAdmin(admin: AdminAttributes): void {
  const failures = adminCheckFailures(admin);
  if (failures.length > 0) throw new PostgresCheckError(failures);
}

/** The channel of the round trip. Studio listens on libredb_bridge, so the check never wakes it. */
export const CHECK_CHANNEL = "libredb_installer_check";

/** LISTEN and NOTIFY in one session: psql prints the notification the session sends to itself. */
export function notifyRoundTripScript(nonce: string): string {
  const channel = quoteIdent(CHECK_CHANNEL);
  return `LISTEN ${channel};\nNOTIFY ${channel}, ${quoteLiteral(nonce)};\n`;
}

/**
 * Passes when psql printed the notification with this run's nonce. LISTEN fails on a hot standby and loses its
 * notifications behind a transaction-mode pooler, and Studio's governance connection needs it.
 */
export function checkNotifyRoundTrip(result: PsqlResult, nonce: string, login: PsqlLogin): void {
  const where = `a LISTEN/NOTIFY round trip as ${login.user} on ${login.host}:${login.port}`;
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new PostgresCheckError([
      `${where} failed: psql exited with code ${result.exitCode}${stderr === "" ? "" : `: ${stderr}`}`,
    ]);
  }
  if (!result.stdout.includes(`Asynchronous notification "${CHECK_CHANNEL}" with payload "${nonce}"`)) {
    throw new PostgresCheckError([
      `${where} received no notification, so LISTEN does not work there: ` +
        "Studio needs the primary directly or through a session-mode pooler",
    ]);
  }
}
