// The runner interface of provisioning and of the verify checks: one psql script, run as one role against one
// PostgreSQL server. The Docker adapter runs psql in a one-shot container and the Kubernetes adapter in a Job; both
// hand psql the PG* variables of pgEnvironment and the script on standard input, so no password reaches a command
// line and the script carries SCRAM verifiers at most.
import type { z } from "zod";
import { ExitCode } from "../cli/exit-codes";
import { formatPath } from "../config/schema";
import { CA_BUNDLE_MOUNT_PATH } from "../tls/bundle";
import { quoteLiteral } from "./quote";

/** Where psql connects and as which role. */
export interface PsqlLogin {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Reaches psql only as PGPASSWORD, never in the script or on a command line. */
  password: string;
}

/** What psql did with one script. */
export interface PsqlResult {
  exitCode: number;
  /** The redacted standard output. */
  stdout: string;
  /** The redacted standard error. */
  stderr: string;
}

export interface SqlRunner {
  /**
   * Runs the script with psql as the login, with PSQL_ARGS and the variables of pgEnvironment, and resolves with
   * psql's exit code and output. It rejects only when psql could not be started at all.
   */
  run(login: PsqlLogin, script: string): Promise<PsqlResult>;
}

/** psql reads no psqlrc, prints only query results, unaligned and without headers, and stops at the first error. */
export const PSQL_ARGS = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"] as const;

/** The application name the server reports for every installer session. */
export const PSQL_APPLICATION_NAME = "libredb-installer";

/**
 * The PG* variables of a login. psql verifies the server certificate and its hostname against the CA bundle, which
 * every runner mounts at /etc/libredb/ca/ca.crt, with sslmode verify-full.
 */
export function pgEnvironment(login: PsqlLogin): Record<string, string> {
  return {
    PGHOST: login.host,
    PGPORT: String(login.port),
    PGDATABASE: login.database,
    PGUSER: login.user,
    PGPASSWORD: login.password,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: CA_BUNDLE_MOUNT_PATH,
    PGAPPNAME: PSQL_APPLICATION_NAME,
    PGCONNECT_TIMEOUT: "10",
  };
}

/** The variables as `KEY=VALUE` lines of a Docker env file, which takes each value verbatim up to the line break. */
export function envFileText(variables: Readonly<Record<string, string>>): string {
  return Object.entries(variables)
    .map(([key, value]) => {
      if (/[\0\n\r]/.test(value)) throw new Error(`the value of ${key} contains a line break or a NUL character`);
      return `${key}=${value}\n`;
    })
    .join("");
}

/** Names a login in messages, without its password, such as `libredb_studio on postgres:5432/libredb`. */
export function describeLogin(login: PsqlLogin): string {
  return `${login.user} on ${login.host}:${login.port}/${login.database}`;
}

/** A psql run that exited with an error, named by its login and psql's standard error. */
export class SqlError extends Error {
  readonly exitCode = ExitCode.RuntimeFailure;
  readonly result: PsqlResult;

  constructor(login: PsqlLogin, result: PsqlResult) {
    const stderr = result.stderr.trim();
    super(`psql as ${describeLogin(login)} exited with code ${result.exitCode}${stderr === "" ? "" : `: ${stderr}`}`);
    this.name = "SqlError";
    this.result = result;
  }
}

/** Runs the script and rejects with SqlError when psql exits with an error. */
export async function runScript(runner: SqlRunner, login: PsqlLogin, script: string): Promise<PsqlResult> {
  const result = await runner.run(login, script);
  if (result.exitCode !== 0) throw new SqlError(login, result);
  return result;
}

/** Marks a line of standard output as a result of the installer's own queries. */
export const RESULT_PREFIX = "libredb-result";

/** A query that prints one result line: the prefix, the name and the JSON of `expression`, which must be jsonb. */
export function resultQuery(name: string, expression: string): string {
  return `SELECT ${quoteLiteral(`${RESULT_PREFIX} ${name} `)} || (${expression})::text;`;
}

const RESULT_LINE = new RegExp(`^${RESULT_PREFIX} ([a-z0-9-]+) (.*)$`);

/**
 * Reads the result lines in psql's standard output by name and ignores every other line. A result that is not JSON,
 * or a name that appears twice, is an error.
 */
export function parseResults(stdout: string): Map<string, unknown> {
  const results = new Map<string, unknown>();
  for (const line of stdout.split("\n")) {
    const match = RESULT_LINE.exec(line);
    if (match === null) continue;
    const [, name = "", json = ""] = match;
    if (results.has(name)) throw new Error(`psql printed the result ${name} twice`);
    try {
      results.set(name, JSON.parse(json));
    } catch {
      throw new Error(`psql printed the result ${name} as invalid JSON`);
    }
  }
  return results;
}

/** Validates a parsed result against its schema, naming every malformed path but never quoting a value. */
export function parseResult<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
    throw new Error(`the ${what} are malformed: ${issues.join("; ")}`);
  }
  return parsed.data;
}
