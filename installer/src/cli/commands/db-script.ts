// `db-script -c <libredb.yaml> -o <file>`: with postgres.external.provisioning manual, writes the provisioning
// script of Platform's PostgreSQL bootstrap that a DBA runs once on the external PostgreSQL server before apply. It
// generates each role password the installer stores that is missing, once, and the script carries their
// SCRAM-SHA-256 verifiers, never a cleartext password. The file gets mode 0600, through the output helper that the
// other commands with -o use as well.
import { writeOutputFile } from "../../adapters/output-file";
import { loadConfig } from "../../config/load";
import { ConfigError, type LibreDBInstallation } from "../../config/schema";
import { APP_ROLES, renderDbaScript, ROLE_SPECS } from "../../sql/provision";
import { acquireLock } from "../../state/lock";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { describeError, parseRunArgs, UsageError, withDockerSession } from "./docker-session";

export const DB_SCRIPT_USAGE = `Usage: libredb-installer db-script -c <libredb.yaml> [--set path=value]... -o <file> [--force]

With postgres.external.provisioning manual, writes the script that a DBA runs once with psql on the external
PostgreSQL server, as a superuser or as a role with CREATEROLE and CREATEDB, before apply. It generates the role
passwords the installer stores when they are missing, and the script carries their SCRAM-SHA-256 verifiers only.
An existing <file> is replaced only with --force, and <file> follows the rules of tls export-ca -o.
`;

/** Why db-script does not apply to the configuration, or undefined when it does. */
export function dbScriptRefusal(config: LibreDBInstallation): string | undefined {
  if (config.postgres.mode !== "external") {
    return "postgres.mode: db-script writes the DBA script of an external PostgreSQL server, and the configuration sets managed";
  }
  if (config.postgres.external.provisioning !== "manual") {
    return (
      "postgres.external.provisioning: db-script writes the DBA script of provisioning manual, and with installer apply " +
      "provisions the server itself"
    );
  }
  return undefined;
}

export async function runDbScript(args: readonly string[], io: Output): Promise<ExitCode> {
  let parsed;
  try {
    parsed = parseRunArgs("db-script", args, { output: true, force: true });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\n\n${DB_SCRIPT_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  const file = parsed.output;
  if (file === undefined || file === "") {
    io.stderr(`db-script: --output (-o) is required\n\n${DB_SCRIPT_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  // Refused before the session, so a configuration db-script does not serve changes nothing on the host.
  let refusal: string | undefined;
  try {
    refusal = dbScriptRefusal(loadConfig({ file: parsed.config, sets: parsed.sets }));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr(`db-script: ${describeError(error)}\n`);
    return ExitCode.InvalidUsage;
  }
  if (refusal !== undefined) {
    io.stderr(`db-script: ${refusal}\n`);
    return ExitCode.InvalidUsage;
  }
  return withDockerSession("db-script", parsed, io, async (session) => {
    const { config } = session;
    if (config.postgres.mode !== "external") throw new Error("db-script needs an external PostgreSQL server");
    const managedKeycloak = config.keycloak.mode === "managed";
    const roles = APP_ROLES.filter((role) => role !== "keycloak" || managedKeycloak);
    const lock = acquireLock();
    try {
      const stored = await session.context.secrets.ensure(roles.map((role) => ROLE_SPECS[role].secret));
      const passwords = Object.fromEntries(roles.map((role) => [role, stored[ROLE_SPECS[role].secret]]));
      const { host, port } = config.postgres.external;
      // A refused path throws an OutputPathError, which the session answers with exit 2 and its message.
      writeOutputFile(file, renderDbaScript({ passwords, managedKeycloak, server: { host, port } }), {
        mode: 0o600,
        force: parsed.force,
      });
      session.log.write("info", `db-script wrote ${file}`);
      io.stdout(
        `Wrote ${file}. Have a DBA run it once with psql on ${host}:${port} as a superuser or as a role with ` +
          "CREATEROLE and CREATEDB, then run apply.\n",
      );
      return ExitCode.Ok;
    } finally {
      lock.release();
    }
  });
}
