// `preflight`: runs step 1 of the Docker graph, which checks the host and an external Keycloak and changes nothing.
import { planGraph } from "../../engine/graph";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { instrumented, parseRunArgs, UsageError, withDockerSession } from "./docker-session";

export const PREFLIGHT_USAGE = `Usage: libredb-installer preflight -c <libredb.yaml> [--set path=value]...

Checks the host against the release: Linux, root, Docker Engine and the Compose v2 plugin, the host tools the
installer runs (ss always, and systemctl with docker.systemdUnit: true), and free published ports.
With keycloak.mode external it also checks the customer's Keycloak: TLS, the reused realm, the version, the app
clients and the clock. With postgres.mode external it also checks the PostgreSQL server: version, standby, admin
role, connection budget, TLS and clock skew. Exits 3 naming every problem it finds, and prints every warning.
`;

export async function runPreflight(args: readonly string[], io: Output): Promise<ExitCode> {
  let parsed;
  try {
    parsed = parseRunArgs("preflight", args, {});
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\n\n${PREFLIGHT_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  return withDockerSession("preflight", parsed, io, async (session) => {
    const options = session.graph(["preflight"]);
    await planGraph({ ...options, steps: instrumented(options.steps, session.log, undefined) });
    for (const warning of session.warnings) io.stdout(session.redactor.redact(`Warning: ${warning}\n`));
    io.stdout("Preflight passed\n");
    return ExitCode.Ok;
  });
}
