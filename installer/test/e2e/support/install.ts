// What the nightly end-to-end tests share: the compiled installer, run with stdin on /dev/null so it never sees a
// terminal, commands on this host's Docker Engine, and the removal of an earlier install under the fixed
// /opt/libredb and Compose project libredb. They need root on a disposable Linux host with Docker.
// LIBREDB_INSTALLER_BIN names another installer binary than dist/libredb-installer-linux-x64, and
// LIBREDB_E2E_IMAGES_REGISTRY sets images.registry for every run, such as registry.example.com/libredb.
import { existsSync, rmSync } from "node:fs";
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
