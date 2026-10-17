// `db-shell --as platform [-c <sql>]`: opens psql as libredb_platform in a one-shot container on the installation's
// data network, for the break-glass procedure, such as withdrawing a user's access while Keycloak is down. It reads the
// installed compose file and the secret store, so it takes no configuration, and its run log keeps the statements it
// ran. An external PostgreSQL server is the one the compose file records in its x-libredb field.
import { parseArgs } from "node:util";
import { readOptionalFile } from "../../adapters/host-fs";
import { DockerPsqlRunner, interactivePsql } from "../../adapters/psql-docker";
import { CA_BUNDLE_FILE, ENV_DIR, runLogFile, SECRETS_DIR } from "../../docker/layout";
import { composeNetworks, serviceDefinition } from "../../docker/project";
import { Redactor } from "../../log/redact";
import { PreflightError } from "../../preflight/docker-checks";
import type { PostgresServer } from "../../model/database-urls";
import { MANAGED_POSTGRES_PORT } from "../../model/desired";
import { COMPOSE_FILE, composeExternalPostgres } from "../../render/compose";
import { FileSecretStore } from "../../secrets/file-store";
import { ROLE_SPECS } from "../../sql/provision";
import { platformLogin, secretValue } from "../../steps/platform-deploy";
import { POSTGRES_DOCKER_SERVICE } from "../../tls/plan";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { describeError, exitCodeOf, RunLog } from "./docker-session";

export const DB_SHELL_USAGE = `Usage: libredb-installer db-shell --as platform [-c <sql>]

Opens psql as libredb_platform in a one-shot container on the installation's data network.
With -c it runs the SQL and prints the rows unaligned and without headers; without it psql runs on this terminal.
`;

/** psql reads the SQL from standard input, stops at the first error and prints rows unaligned without headers. */
const COMMAND_PSQL_ARGS = ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"] as const;

const NAME_PREFIX = "libredb-db-shell";

export interface DbShellTerminal {
  /** Whether stdin is a terminal that psql can run on. */
  isTTY: boolean;
}

/**
 * The installed PostgreSQL image, data network and server, read from the compose file that apply rendered: the managed
 * server's service, or the external server the compose file records.
 */
function installedServer(): { image: string; network: string; server: PostgresServer } {
  const compose = readOptionalFile(COMPOSE_FILE);
  if (compose === undefined) throw new Error(`${COMPOSE_FILE} does not exist, so no installation is there; run apply first`);
  const network = composeNetworks(compose).find((candidate) => candidate.key === "data");
  if (network === undefined) throw new Error(`${COMPOSE_FILE} has no data network`);
  const external = composeExternalPostgres(compose);
  if (external !== undefined) {
    return { image: external.psqlImage, network: network.name, server: { host: external.host, port: external.port } };
  }
  const { image } = serviceDefinition(compose, POSTGRES_DOCKER_SERVICE) as { image?: unknown };
  if (typeof image !== "string") throw new Error(`${COMPOSE_FILE} has no PostgreSQL image`);
  return { image, network: network.name, server: { host: POSTGRES_DOCKER_SERVICE, port: MANAGED_POSTGRES_PORT } };
}

export async function runDbShell(
  args: readonly string[],
  io: Output,
  terminal: DbShellTerminal = { isTTY: process.stdin.isTTY === true },
): Promise<ExitCode> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { as: { type: "string" }, command: { type: "string", short: "c" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.stderr(`db-shell: ${(error as Error).message}\n\n${DB_SHELL_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  if (values.as !== "platform") {
    const found = values.as === undefined ? "" : `, not ${values.as}`;
    io.stderr(`db-shell: --as must be platform${found}\n\n${DB_SHELL_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  const command = values.command;
  if (command === undefined && !terminal.isTTY) {
    io.stderr(`db-shell: stdin is not a terminal, so pass the SQL with -c\n\n${DB_SHELL_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  const redactor = new Redactor();
  let log: RunLog | undefined;
  try {
    const uid = process.getuid?.() ?? -1;
    if (uid !== 0) throw new PreflightError([`the installer must run as root, and it runs as uid ${uid}`]);
    const { server, ...installed } = installedServer();
    const secrets = new FileSecretStore({ dir: SECRETS_DIR, redactor });
    const login = platformLogin(server, await secretValue({ secrets }, ROLE_SPECS.platform.secret));
    log = new RunLog(runLogFile(new Date()), redactor);
    log.write("info", `libredb-installer db-shell --as platform${command === undefined ? "" : ` -c ${command}`}`);
    const options = { ...installed, caBundleFile: CA_BUNDLE_FILE, envDir: ENV_DIR, namePrefix: NAME_PREFIX };
    let code: ExitCode;
    if (command === undefined) {
      code = (await interactivePsql(options, login)) === 0 ? ExitCode.Ok : ExitCode.RuntimeFailure;
    } else {
      const runLog = log;
      const runner = new DockerPsqlRunner({
        ...options,
        redactor,
        log: (line) => runLog.write("debug", `${line.stream}: ${line.text}`),
        psqlArgs: COMMAND_PSQL_ARGS,
      });
      const result = await runner.run(login, `${command}\n`);
      io.stdout(result.stdout);
      io.stderr(result.stderr);
      code = result.exitCode === 0 ? ExitCode.Ok : ExitCode.RuntimeFailure;
    }
    log.write("info", `db-shell exited with ${code}`);
    return code;
  } catch (error) {
    const message = redactor.redact(describeError(error));
    io.stderr(`db-shell: ${message}\n`);
    log?.write("error", `db-shell failed: ${message}`);
    return exitCodeOf(error);
  } finally {
    log?.close();
  }
}
