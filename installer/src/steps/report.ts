// The `report` step, the last of the graph: what a full `apply` prints last. It names the three URLs, the CA bundle,
// the license that platform-license read, the files that hold the temporary passwords and the next steps, the checks
// that failed, and the warnings of the checks and of the steps. It prints paths only, never a secret value.
import type { DockerInstallation } from "../config/schema";
import type { DesiredInstallation } from "../model/desired";
import { COMPOSE_PROJECT, STUDIO_SERVICE } from "../render/compose";
import type { CheckResult } from "../verify/catalogue";
import { platformLicenseCheck } from "../verify/platform-license";

export interface ReportInput {
  desired: DesiredInstallation;
  config: DockerInstallation;
  /** The configuration file apply ran with, for the commands of the next steps. */
  configFile: string;
  caBundleFile: string;
  /** The files with the temporary passwords of the first admin and the user manager. */
  passwordFiles: { "first-admin": string; "user-manager": string };
  results: readonly CheckResult[];
  warnings: readonly string[];
}

/**
 * The first next step, the CA that browsers must trust: in tls.mode generated the internal CA, which issues the edge's
 * leaves and which `tls export-ca` writes, and otherwise the customer's CA, which the certificates browsers see chain to.
 */
function trustStep(tls: DockerInstallation["tls"]): string {
  if (tls.mode === "generated") {
    return (
      "Run 'libredb-installer tls export-ca -o ca.crt' and add ca.crt, the internal CA, to the trust store of every " +
      "browser and client that opens the URLs above."
    );
  }
  const certificates = tls.mode === "provided" ? "the certificates of tls.provided" : "the certificates of your TLS proxy";
  return (
    `Make sure every browser and client that opens the URLs above trusts the CA in ${tls.caBundleFile}, which ` +
    `${certificates} chain to; they do not need the internal CA.`
  );
}

export function formatReport(input: ReportInput): string {
  const { desired, config } = input;
  const failedChecks = input.results.filter((result) => result.result === "failed");
  const lines: string[] = [""];
  lines.push(
    failedChecks.length === 0
      ? "LibreDB is installed and every verify check passed."
      : `LibreDB is installed, but ${failedChecks.length} of ${input.results.length} verify checks failed:`,
  );
  for (const check of failedChecks) lines.push(`  ${check.id}: ${check.cause}`);
  if (failedChecks.some((check) => check.id.startsWith("studio-"))) {
    lines.push(`  Studio's own log has the full message: docker compose -p ${COMPOSE_PROJECT} logs ${STUDIO_SERVICE}`);
  }
  lines.push(
    "",
    "URLs:",
    `  Platform  ${desired.urls.platform}`,
    `  Studio    ${desired.urls.studio}`,
    `  Auth      ${desired.urls.auth}`,
  );
  if (desired.style === "ports") {
    lines.push(
      "",
      `Endpoint style: the ports style serves Platform, Studio and Keycloak on one host, ${desired.hosts.platform}, ` +
        "so the apps share cookies and HSTS, which browsers scope by host and not by port.",
      "Each app's server receives the cookies of the others, and script on one app can set cookies that the others " +
        "read, so a compromise of one app reaches the sessions of the others.",
      "The ports style is a documented downgrade from separate hostnames, for sites where DNS is impossible.",
    );
  }
  lines.push(
    "",
    `CA bundle: ${input.caBundleFile}`,
  );
  // The license as platform-license found it; a check that failed without reading it names none.
  const license = input.results.find((result) => result.id === platformLicenseCheck.id);
  if (license !== undefined) {
    lines.push(`License: ${license.detail ?? `unknown, because the check ${license.id} failed`}`);
  }
  // An account exists only while it is enabled; a reused realm's users are its identity team's.
  const { mode, firstAdmin, userManager } = config.keycloak;
  const passwords = [
    ...(firstAdmin.enabled ? [`  First LibreDB admin ${firstAdmin.username}: ${input.passwordFiles["first-admin"]}`] : []),
    ...(userManager.enabled ? [`  Keycloak user manager ${userManager.username}: ${input.passwordFiles["user-manager"]}`] : []),
  ];
  if (passwords.length > 0) lines.push("", "Temporary passwords:", ...passwords);
  const steps = [trustStep(config.tls)];
  if (firstAdmin.enabled) {
    steps.push(
      `Sign in to Platform as ${firstAdmin.username} with the temporary password; Keycloak asks for a new password and a TOTP device.`,
    );
  }
  if (userManager.enabled) {
    const signIn =
      mode === "managed"
        ? `Run 'libredb-installer keycloak console -c ${input.configFile}' and sign in`
        : `Sign in to ${desired.keycloak.adminUrl}/admin/${desired.realm}/console/`;
    steps.push(`${signIn} as ${userManager.username} to create users and give them libredb:admin or libredb:user.`);
  }
  if (mode === "external") {
    steps.push(
      `Ask the administrators of realm ${desired.realm} to give each LibreDB user the role admin or user of client libredb, directly or through a group.`,
    );
  }
  if (passwords.length > 1) {
    steps.push("Delete each temporary password file once its account has set its own password.");
  } else if (passwords.length === 1) {
    steps.push(`Delete the temporary password file once the ${firstAdmin.enabled ? "first admin" : "user manager"} has set its own password.`);
  }
  lines.push("", "Next steps:", ...steps.map((step, index) => `  ${index + 1}. ${step}`));
  const warnings = [
    ...input.results.filter((result) => result.result === "warning").map((result) => `verify ${result.id}: ${result.cause}`),
    ...input.warnings,
  ];
  if (warnings.length > 0) {
    lines.push("", "Warnings:", ...warnings.map((warning) => `  - ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}
