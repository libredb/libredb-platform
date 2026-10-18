// What the end-to-end tests share: the compiled installer, run with stdin on /dev/null so it never sees a terminal,
// the license of every install, commands on this host's Docker Engine, and the removal of an earlier install under the
// fixed /opt/libredb and Compose project libredb. They need root on a disposable Linux host with Docker.
// LIBREDB_INSTALLER_BIN names another installer binary than dist/libredb-installer-linux-x64, and
// LIBREDB_E2E_IMAGES_REGISTRY sets images.registry for every run, such as registry.example.com/libredb.
// LIBREDB_E2E_LICENSE_FILE is required: every install needs a license, and every test file that installs fails at load
// without it, or when its file holds no license token.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_ROOT = join(import.meta.dir, "..", "..", "..");
export const INSTALLER = process.env.LIBREDB_INSTALLER_BIN ?? join(PACKAGE_ROOT, "dist", "libredb-installer-linux-x64");
export const INSTALL_ROOT = "/opt/libredb";
export const PROJECT = "libredb";
const registryVariable = process.env.LIBREDB_E2E_IMAGES_REGISTRY;
/** images.registry of every run, or undefined for the release's own registries. */
export const REGISTRY = registryVariable === undefined || registryVariable === "" ? undefined : registryVariable;
export const REGISTRY_ARGS = REGISTRY === undefined ? [] : ["--set", `images.registry=${REGISTRY}`];
export const VERIFIED = "LibreDB is installed and every verify check passed.";

/** What the license of every install must be, as each message about a missing or broken one says. */
const CI_LICENSE =
  "a license that the pinned Platform image verifies for platform.libredb.test and lab.libredb.test, with 1 admin " +
  "seat and 3 user seats, such as the CI license of the repository secret LIBREDB_E2E_LICENSE";

const licenseFileVariable = process.env.LIBREDB_E2E_LICENSE_FILE;
if (licenseFileVariable === undefined || licenseFileVariable === "") {
  throw new Error(
    "LIBREDB_E2E_LICENSE_FILE must name the file of the license that every install of the end-to-end tests names in " +
      `platform.licenseFile: ${CI_LICENSE}`,
  );
}
/** The license file of every install, read only to decode its payload and to compare and search for its token. */
export const LICENSE_FILE: string = licenseFileVariable;
/** The --set override that gives a configuration the license file of every install. */
export const LICENSE_ARGS = ["--set", `platform.licenseFile=${LICENSE_FILE}`];

/** What the tests compare of the license of every install: the id, the customer and the expiry of its payload. */
export interface E2ELicense {
  readonly id: string;
  readonly customer: string;
  /** When the license expires, in epoch seconds. */
  readonly expiresAt: number;
}

/**
 * The payload of the token in LICENSE_FILE, the base64url JSON of its third dot-separated segment. Every message thrown
 * here is fixed, because the message of a JSON error quotes the text it read, which is part of the token.
 */
function readLicense(): E2ELicense {
  const token = readFileSync(LICENSE_FILE, "utf8").replace(/\r?\n$/, "");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token.split(".")[2] ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error(
      "LIBREDB_E2E_LICENSE_FILE does not hold a license token: its third segment is not the base64url of a JSON " +
        `object, and it must hold ${CI_LICENSE}`,
    );
  }
  const fields = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const { id, customer, expiresAt } = fields;
  if (typeof id !== "string" || typeof customer !== "string" || typeof expiresAt !== "number") {
    throw new Error(
      "LIBREDB_E2E_LICENSE_FILE does not hold a license token: its payload has no id, customer or expiry, and it must " +
        `hold ${CI_LICENSE}`,
    );
  }
  return { id, customer, expiresAt };
}

/** The license of every install, read when this module loads, so every test file fails at load without a token. */
export const LICENSE = readLicense();

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface VerifyReport {
  checks: { id: string; result: string; cause: string | null }[];
}

/** Runs a command to its end, and throws with its standard error when `check` is set and it exits non-zero. */
export function sh(argv: string[], check = true, stdin?: Uint8Array): RunResult {
  const result = Bun.spawnSync(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`${argv.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

/**
 * Runs the installer with `env` on top of this process's environment, where an undefined value removes the variable,
 * so a run without a credential cannot inherit one.
 */
export async function installer(args: string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete merged[name];
    else merged[name] = value;
  }
  const child = Bun.spawn([INSTALLER, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: merged });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** Throws unless this process runs as root on Linux and the compiled installer exists. */
export function requireDisposableHost(): void {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("the Docker end-to-end tests need root on a disposable Linux host with Docker");
  }
  if (!existsSync(INSTALLER)) throw new Error(`${INSTALLER} does not exist; run bun run build first`);
}

/** Removes `containers` first, then every container, network and volume of the project and /opt/libredb. */
export function removeInstall(containers: readonly string[] = []): void {
  // Containers outside the project first, because they may hold an endpoint on one of its networks.
  if (containers.length > 0) sh(["docker", "rm", "--force", "--volumes", ...containers], false);
  const label = `label=com.docker.compose.project=${PROJECT}`;
  const ids = (kind: string[]) => sh([...kind, "--filter", label, "--quiet"]).stdout.split("\n").filter(Boolean);
  const projectContainers = ids(["docker", "ps", "--all"]);
  if (projectContainers.length > 0) sh(["docker", "rm", "--force", "--volumes", ...projectContainers]);
  const networks = ids(["docker", "network", "ls"]);
  if (networks.length > 0) sh(["docker", "network", "rm", ...networks]);
  const volumes = ids(["docker", "volume", "ls"]);
  if (volumes.length > 0) sh(["docker", "volume", "rm", "--force", ...volumes]);
  rmSync(INSTALL_ROOT, { recursive: true, force: true });
}

/** The verify checks that failed. */
export function failedChecks(report: VerifyReport): VerifyReport["checks"] {
  return report.checks.filter((check) => check.result === "failed");
}
