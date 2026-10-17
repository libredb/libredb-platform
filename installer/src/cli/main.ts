import { runApply } from "./commands/apply";
import { runDbScript } from "./commands/db-script";
import { runDbShell } from "./commands/db-shell";
import { runImages } from "./commands/images";
import { runKeycloak } from "./commands/keycloak-console";
import { runPlan } from "./commands/plan";
import { runPreflight } from "./commands/preflight";
import { runStatus } from "./commands/status";
import { runTls } from "./commands/tls";
import { runValidate } from "./commands/validate";
import { runVerify } from "./commands/verify";
import { runVersion } from "./commands/version";
import { ExitCode } from "./exit-codes";

export interface Output {
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE = `Usage: libredb-installer <command>

Commands:
  version       Print the installer version, the release version and its contract versions
  validate      Validate a configuration and print it normalized
  images list   Print the release's image references, pinned by digest
  preflight     Check the host against the release
  plan          Print what apply would change
  apply         Converge the host on the configuration, after confirmation or with --yes
  verify        Run every check of the installation, as text or with --output json, and exit 4 when one fails
  status        Print each step's last result, the lock holder and the health of every container
  keycloak console  Print the realm console URL of the managed Keycloak and the SSH tunnel that reaches it
  keycloak export -o <dir>  Write the Keycloak objects for a realm the site configures itself
  tls export-ca  Write the internal CA certificate to the file of -o, or to standard output
  db-shell --as platform  Open psql as libredb_platform on the data network, or run the SQL of -c
  db-script -o <file>     Write the DBA script of an external PostgreSQL server with provisioning manual
`;

export async function main(argv: readonly string[], io: Output): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "version":
      return runVersion(io);
    case "validate":
      return runValidate(args, io);
    case "images":
      return runImages(args, io);
    case "preflight":
      return runPreflight(args, io);
    case "plan":
      return runPlan(args, io);
    case "apply":
      return runApply(args, io);
    case "verify":
      return runVerify(args, io);
    case "status":
      return runStatus(args, io);
    case "keycloak":
      return runKeycloak(args, io);
    case "db-shell":
      return runDbShell(args, io);
    case "tls":
      return runTls(args, io);
    case "db-script":
      return runDbScript(args, io);
    default:
      io.stderr(command === undefined ? USAGE : `unknown command '${command}'\n\n${USAGE}`);
      return ExitCode.InvalidUsage;
  }
}

if (import.meta.main) {
  const processOutput: Output = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  try {
    process.exitCode = await main(process.argv.slice(2), processOutput);
  } catch (error) {
    processOutput.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = ExitCode.RuntimeFailure;
  }
}
