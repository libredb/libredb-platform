// The entry point of the Helm chart's jobs, bundled by scripts/build-helm-jobs.ts into
// charts/libredb-platform/files/libredb-jobs.cjs and run by the Platform image's node:
//
//   node libredb-jobs.cjs bootstrap   the pre-install and pre-upgrade hook: secrets, seal keys, TLS, envs
//   node libredb-jobs.cjs keycloak    the keycloak-configure job
//   node libredb-jobs.cjs restart     the post-install and post-upgrade hook: the restarts the bootstrap asked for
//
// The installation document is the chart's rendering of the Helm values as a LibreDBInstallation of mode kubernetes,
// validated by the installer's own schema. Every line the job prints passes through the redactor.
import { readFileSync, writeFileSync } from "node:fs";
import { KubernetesApi } from "../adapters/kubernetes-api";
import { ConfigError, parseInstallation } from "../config/schema";
import { ExitCode } from "./exit-codes";
import { runBootstrap, runRestarts } from "../kubernetes/bootstrap";
import { JOBS_BUNDLE_KEY } from "../kubernetes/names";
import { runKeycloakJob } from "../kubernetes/keycloak";
import { Redactor } from "../log/redact";
import { parseReleaseManifest } from "../release/manifest";
import { applyKeycloak, observeKeycloak } from "../steps/keycloak-configure";
import manifestDocument from "../../release/release.config.json" with { type: "json" };

/** Where the chart mounts its ConfigMap with installation.json and chart.json. */
export const CHART_CONFIG_DIR = "/etc/libredb/chart";

/** Where the chart mounts the gzipped bundle this file was decompressed from. */
export const JOBS_DIR = "/etc/libredb/jobs";

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readJson(path: string): unknown {
  const text = readOptional(path);
  if (text === undefined) throw new Error(`${path} is missing: the chart mounts it from its ConfigMap`);
  return JSON.parse(text);
}

/** The error's message with its causes, such as the connection error behind `fetch failed`. */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let current: unknown = error; current !== undefined && parts.length < 4; current = (current as { cause?: unknown }).cause) {
    parts.push(current instanceof Error ? current.message : String(current));
    if (!(current instanceof Error)) break;
  }
  return parts.join(": ");
}

/**
 * The job's exit code: the installer's code of a refusal that a retry cannot change (an invalid installation, a failed
 * precondition, an unsafe change), on which the chart's podFailurePolicy fails the Job at once, and 1 otherwise.
 */
export function jobExitCode(error: unknown): number {
  if (error instanceof ConfigError) return ExitCode.InvalidUsage;
  const code = (error as { exitCode?: unknown }).exitCode;
  const final: readonly number[] = [ExitCode.InvalidUsage, ExitCode.PreflightFailed, ExitCode.UnsafeChangeRefused];
  return typeof code === "number" && final.includes(code) ? code : ExitCode.RuntimeFailure;
}

async function main(command: string | undefined): Promise<void> {
  const redactor = new Redactor();
  const log = (line: string) => console.log(redactor.redact(line));
  try {
    const chart = readJson(`${CHART_CONFIG_DIR}/chart.json`) as { studioSecretName?: unknown; labels?: unknown };
    const labels = (chart.labels ?? {}) as Record<string, string>;
    const manifest = parseReleaseManifest(manifestDocument);
    if (command === "restart") {
      const objects = KubernetesApi.inCluster(process.env, readOptional, labels);
      await runRestarts(objects, manifest.version, () => new Date(), log);
      return;
    }
    const config = parseInstallation(readJson(`${CHART_CONFIG_DIR}/installation.json`));
    if (typeof chart.studioSecretName !== "string" || chart.studioSecretName === "") {
      throw new Error(`${CHART_CONFIG_DIR}/chart.json names no studioSecretName`);
    }
    const objects = KubernetesApi.inCluster(process.env, readOptional, labels);
    if (command === "bootstrap") {
      await runBootstrap(
        { config, manifest, studioSecretName: chart.studioSecretName, jobsBundle: readFileSync(`${JOBS_DIR}/${JOBS_BUNDLE_KEY}`) },
        { objects, readFile: readOptional, env: process.env, now: () => new Date(), log, redactor },
      );
    } else if (command === "keycloak") {
      await runKeycloakJob(
        config,
        manifest,
        {
          objects,
          readFile: readOptional,
          writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
          env: process.env,
          tmpDir: "/tmp",
          owner: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
          log,
          redactor,
        },
        { observe: observeKeycloak, apply: applyKeycloak },
      );
    } else {
      console.error("usage: libredb-jobs.cjs bootstrap|keycloak|restart");
      process.exitCode = 64;
      return;
    }
  } catch (error) {
    const message = error instanceof ConfigError ? `invalid installation:\n${error.message}` : describeError(error);
    console.error(redactor.redact(`error: ${message}`));
    process.exitCode = jobExitCode(error);
  }
}

void main(process.argv[2]);
