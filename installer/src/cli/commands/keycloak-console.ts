// `keycloak console`: prints the URL of the realm console of a managed Keycloak, which listens only on the loopback
// admin port, and the SSH tunnel a remote operator opens to reach it.
import { hostname, userInfo } from "node:os";
import { parseArgs } from "node:util";
import { loadConfig } from "../../config/load";
import { ConfigError } from "../../config/schema";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { KEYCLOAK_EXPORT_USAGE, runKeycloakExport } from "./keycloak-export";

export const KEYCLOAK_CONSOLE_USAGE = `Usage: libredb-installer keycloak console -c <libredb.yaml> [--set path=value]...

Prints the realm console URL of the managed Keycloak, which listens only on 127.0.0.1:<keycloak.adminPort>,
and the SSH tunnel that reaches it from a remote workstation.
`;

export const KEYCLOAK_USAGE = `${KEYCLOAK_CONSOLE_USAGE}\n${KEYCLOAK_EXPORT_USAGE}`;

/** The realm console URL and the SSH tunnel command for a managed Keycloak. */
export function consoleText(input: { adminPort: number; realm: string; host: string; user: string }): string {
  const { adminPort, realm, host, user } = input;
  return [
    `Realm console: http://127.0.0.1:${adminPort}/admin/${realm}/console/`,
    "It listens only on this host's loopback interface. From a remote workstation, open an SSH tunnel first:",
    `  ssh -N -L ${adminPort}:127.0.0.1:${adminPort} ${user}@${host}`,
    "then open the same URL in the workstation's browser.",
    "",
  ].join("\n");
}

export async function runKeycloak(args: readonly string[], io: Output): Promise<ExitCode> {
  const [subcommand, ...rest] = args;
  if (subcommand === "export") return runKeycloakExport(rest, io);
  if (subcommand !== "console") {
    io.stderr(`${subcommand === undefined ? "" : `keycloak: unknown subcommand '${subcommand}'\n\n`}${KEYCLOAK_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  let file: string | undefined;
  let sets: string[];
  try {
    const { values } = parseArgs({
      args: rest,
      options: { config: { type: "string", short: "c" }, set: { type: "string", multiple: true } },
      strict: true,
      allowPositionals: false,
    });
    file = values.config;
    sets = values.set ?? [];
  } catch (error) {
    io.stderr(`keycloak console: ${(error as Error).message}\n\n${KEYCLOAK_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  if (file === undefined) {
    io.stderr(`keycloak console: --config (-c) is required\n\n${KEYCLOAK_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  let config;
  try {
    config = loadConfig({ file, sets });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr(`invalid configuration:\n${error.issues.map((issue) => `  ${issue}`).join("\n")}\n`);
    return ExitCode.InvalidUsage;
  }
  if (config.keycloak.mode !== "managed") {
    io.stderr("keycloak console: keycloak.mode is external, so open the console of the customer's Keycloak instead\n");
    return ExitCode.InvalidUsage;
  }
  io.stdout(
    consoleText({
      adminPort: config.keycloak.adminPort,
      realm: config.keycloak.realm,
      host: hostname(),
      user: userInfo().username,
    }),
  );
  return ExitCode.Ok;
}
