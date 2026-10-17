// `keycloak export -c <libredb.yaml> -o <dir>`: writes the Keycloak objects that Platform and Studio rely on for the
// configured realm and hosts as the Admin REST requests the installer itself would send to an empty realm, for a site
// whose identity team configures the realm itself (keycloak.external.provisioning manual). It holds no secret and no
// user, so it needs no root, no lock and no access to the host or to Keycloak.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ensureOutputDirectory, OutputPathError, writeOutputFile } from "../../adapters/output-file";
import { loadConfig } from "../../config/load";
import { ConfigError } from "../../config/schema";
import { EXPORT_FILE, keycloakExport, renderExport } from "../../keycloak/export";
import { computeDesired } from "../../model/desired";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { embeddedRelease } from "../release";

export const KEYCLOAK_EXPORT_USAGE = `Usage: libredb-installer keycloak export -c <libredb.yaml> [--set path=value]... -o <dir> [--force]

Writes <dir>/${EXPORT_FILE}: the clients, roles, client scope and role mappings of Platform and Studio for the
configured realm and hosts, as the Admin REST requests the installer would send, without any secret or user.
The site's identity team applies it, or follows installer/docs/keycloak-manual.md, and shares the secrets of
libredb-studio and libredb-platform for keycloak.external.provisioning manual.
<dir> must not contain a symbolic link, and every directory from / down must be owned by root, by the user that
runs the installer or by the operator who ran sudo, and be writable by its owner only, unless it is sticky as /tmp
is. A missing <dir> is created only below an existing parent. An existing export file is replaced only with --force, and a symbolic link is
replaced itself, never followed.
`;

export async function runKeycloakExport(args: readonly string[], io: Output): Promise<ExitCode> {
  let file: string | undefined;
  let output: string | undefined;
  let sets: string[];
  let force: boolean;
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        config: { type: "string", short: "c" },
        set: { type: "string", multiple: true },
        output: { type: "string", short: "o" },
        force: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    file = values.config;
    output = values.output;
    sets = values.set ?? [];
    force = values.force === true;
  } catch (error) {
    io.stderr(`keycloak export: ${(error as Error).message}\n\n${KEYCLOAK_EXPORT_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  if (file === undefined || output === undefined || output === "") {
    const missing = file === undefined ? "--config (-c)" : "--output (-o)";
    io.stderr(`keycloak export: ${missing} is required\n\n${KEYCLOAK_EXPORT_USAGE}`);
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
  if (config.keycloak.mode !== "external") {
    io.stderr("keycloak export: keycloak.mode is managed, and the installer configures its own Keycloak itself\n");
    return ExitCode.InvalidUsage;
  }
  const exported = await keycloakExport(computeDesired(config, embeddedRelease()));
  const target = join(output, EXPORT_FILE);
  try {
    ensureOutputDirectory(output);
    // The export holds no secret, so everyone may read it.
    writeOutputFile(target, renderExport(exported), { mode: 0o644, force });
  } catch (error) {
    if (!(error instanceof OutputPathError)) throw error;
    io.stderr(`keycloak export: ${error.message}\n`);
    return ExitCode.InvalidUsage;
  }
  io.stdout(
    `Wrote ${target} for realm ${exported.realm} (issuer ${exported.issuer}). Apply it in that realm, assign ` +
      "libredb:admin and libredb:user to your users, then set keycloak.external.studioClientSecretEnv or File and " +
      "platformClientSecretEnv or File to the client secrets Keycloak generated.\n",
  );
  return ExitCode.Ok;
}
