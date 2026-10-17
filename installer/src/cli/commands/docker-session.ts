// What the preflight, plan and apply commands share in Docker mode: the arguments, the configuration and the desired
// model, the adapters, the redactor that every generated secret is registered with, and the run log under
// /opt/libredb/logs that records each run redacted.
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { Docker } from "../../adapters/docker";
import type { OutputLine } from "../../adapters/exec";
import { readOptionalFile } from "../../adapters/host-fs";
import { loadConfig } from "../../config/load";
import { ConfigError, type DockerInstallation } from "../../config/schema";
import { BASE_DIRECTORIES, LOGS_DIR, SECRETS_DIR, runLogFile } from "../../docker/layout";
import { dockerSupportIssues } from "../../docker/support";
import type { GraphOptions } from "../../engine/graph";
import type { Step } from "../../engine/step";
import { formatLogLine, Redactor, type LogLevel } from "../../log/redact";
import { computeDesired } from "../../model/desired";
import { INSTALL_ROOT } from "../../render/compose";
import { PreflightError } from "../../preflight/docker-checks";
import { FileSecretStore } from "../../secrets/file-store";
import { FileStateStore } from "../../state/file-store";
import { immutableFieldsOf } from "../../state/immutable";
import { baseDockerStep } from "../../steps/base-docker";
import type { DockerContext } from "../../steps/docker-context";
import { edgeDeployStep } from "../../steps/edge-deploy";
import { imagesStep } from "../../steps/images";
import { keycloakConfigureStep } from "../../steps/keycloak-configure";
import { keycloakDeployStep } from "../../steps/keycloak-deploy";
import { platformDeployStep } from "../../steps/platform-deploy";
import { platformMigrateStep } from "../../steps/platform-migrate";
import { postgresDeployStep } from "../../steps/postgres-deploy";
import { postgresProvisionStep } from "../../steps/postgres-provision";
import { PostgresAdminAccess, preflightStep } from "../../steps/preflight-external";
import { secretsStep } from "../../steps/secrets";
import { studioDeployStep } from "../../steps/studio-deploy";
import { tlsStep } from "../../steps/tls";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { promptSecret } from "../prompt";
import { embeddedRelease } from "../release";

/** The steps of this installer build in Docker mode. */
export const DOCKER_STEPS: readonly Step<DockerContext>[] = [
  preflightStep,
  imagesStep,
  secretsStep,
  tlsStep,
  baseDockerStep,
  edgeDeployStep,
  postgresDeployStep,
  postgresProvisionStep,
  keycloakDeployStep,
  keycloakConfigureStep,
  platformMigrateStep,
  platformDeployStep,
  studioDeployStep,
];

/** A command line that cannot run, answered with exit 2 and the command's usage. */
export class UsageError extends Error {
  readonly exitCode = ExitCode.InvalidUsage;
}

export interface RunArgs {
  config: string;
  sets: string[];
  yes: boolean;
  /** `apply --renew-certificates`: re-issue every leaf from the kept internal CA. */
  renewCertificates: boolean;
  only: string[] | undefined;
  /** The value of --output, when the command accepts it. */
  output: string | undefined;
  /** `--force`: replace the file of --output when it exists, when the command accepts it. */
  force: boolean;
}

export function parseRunArgs(
  command: string,
  args: readonly string[],
  accepts: { yes?: boolean; only?: boolean; output?: boolean; renewCertificates?: boolean; force?: boolean },
): RunArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        config: { type: "string", short: "c" },
        set: { type: "string", multiple: true },
        ...(accepts.yes === true ? { yes: { type: "boolean" as const } } : {}),
        ...(accepts.renewCertificates === true ? { "renew-certificates": { type: "boolean" as const } } : {}),
        ...(accepts.only === true ? { only: { type: "string" as const } } : {}),
        ...(accepts.output === true ? { output: { type: "string" as const, short: "o" } } : {}),
        ...(accepts.force === true ? { force: { type: "boolean" as const } } : {}),
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(`${command}: ${(error as Error).message}`);
  }
  if (values.config === undefined) throw new UsageError(`${command}: --config (-c) is required`);
  const only = values.only as string | undefined;
  return {
    config: values.config,
    sets: values.set ?? [],
    yes: values.yes === true,
    renewCertificates: values["renew-certificates"] === true,
    only: only === undefined ? undefined : only.split(",").map((name) => name.trim()),
    output: values.output as string | undefined,
    force: values.force === true,
  };
}

/** Appends redacted JSON lines to the run log, a 0600 file under /opt/libredb/logs. */
export class RunLog {
  readonly path: string;
  readonly #fd: number;
  readonly #redactor: Redactor;

  constructor(path: string, redactor: Redactor) {
    this.path = path;
    this.#redactor = redactor;
    this.#fd = openSync(path, "a", 0o600);
  }

  write(level: LogLevel, message: string): void {
    writeSync(this.#fd, formatLogLine({ time: new Date(), level, message }, this.#redactor));
  }

  close(): void {
    fsyncSync(this.#fd);
    closeSync(this.#fd);
  }
}

export interface DockerSession {
  config: DockerInstallation;
  context: DockerContext;
  redactor: Redactor;
  log: RunLog;
  /** The warnings the steps recorded in this run, in order. */
  warnings: string[];
  graph: (only: readonly string[] | undefined) => GraphOptions<DockerContext>;
}

function loadDockerConfig(args: RunArgs): DockerInstallation {
  const config = loadConfig({ file: args.config, sets: args.sets });
  const issues = dockerSupportIssues(config);
  if (issues.length > 0 || config.mode !== "docker") throw new ConfigError(issues);
  return config;
}

/**
 * Loads the configuration, refuses a run without root before touching the host, opens the run log and registers every
 * secret the store already holds with the redactor, so no later output can carry one.
 */
export async function openDockerSession(command: string, args: RunArgs): Promise<DockerSession> {
  const config = loadDockerConfig(args);
  const uid = process.getuid?.() ?? -1;
  if (uid !== 0) throw new PreflightError([`the installer must run as root, and it runs as uid ${uid}`]);
  const redactor = new Redactor();
  // The run log is opened before the base step runs, so create its directories with the modes base gives them.
  for (const directory of BASE_DIRECTORIES.filter((entry) => entry.path === INSTALL_ROOT || entry.path === LOGS_DIR)) {
    mkdirSync(directory.path, { recursive: true, mode: directory.mode });
  }
  const log = new RunLog(runLogFile(new Date()), redactor);
  const logLine = (line: OutputLine) => log.write("debug", `${line.stream}: ${line.text}`);
  const secrets = new FileSecretStore({ dir: SECRETS_DIR, redactor });
  await secrets.fingerprints();
  const manifest = embeddedRelease();
  const warnings: string[] = [];
  const external = config.postgres.mode === "external" ? config.postgres.external : undefined;
  const context: DockerContext = {
    config,
    manifest,
    desired: computeDesired(config, manifest),
    docker: new Docker({ redactor, log: logLine }),
    redactor,
    log: logLine,
    secrets,
    now: () => new Date(),
    renewCertificates: args.renewCertificates,
    // apply observes and plans every step once to print the plan and again to apply it, so a step that warns while it
    // plans, such as preflight, would otherwise record its warning twice.
    warn: (message) => {
      if (warnings.includes(message)) return;
      warnings.push(message);
      log.write("warn", message);
    },
    info: (message) => log.write("info", message),
    ...(external?.provisioning === "installer"
      ? {
          postgresAdmin: new PostgresAdminAccess({
            external,
            redactor,
            sources: { env: process.env, readFile: readOptionalFile },
            isTTY: () => process.stdin.isTTY === true,
            prompt: (question) => promptSecret(question),
          }),
        }
      : {}),
  };
  const flags = `${args.renewCertificates ? " --renew-certificates" : ""}${args.only === undefined ? "" : ` --only ${args.only.join(",")}`}`;
  log.write("info", `libredb-installer ${command} -c ${args.config}${flags}`);
  return {
    config,
    context,
    redactor,
    log,
    warnings,
    graph: (only) => ({
      steps: DOCKER_STEPS,
      store: new FileStateStore(),
      context,
      installation: immutableFieldsOf(config),
      ...(only === undefined ? {} : { only }),
    }),
  };
}

/** Wraps each step so the run log records what it planned and the operator sees each action as it is applied. */
export function instrumented(
  steps: readonly Step<DockerContext>[],
  log: RunLog,
  io: Output | undefined,
): Step<DockerContext>[] {
  return steps.map((step) => ({
    name: step.name,
    inputs: (context) => step.inputs(context),
    observe: (run) => step.observe(run),
    async plan(observed, run) {
      const actions = await step.plan(observed, run);
      log.write("info", `step ${step.name}: ${actions.length} action${actions.length === 1 ? "" : "s"} planned`);
      for (const action of actions) log.write("info", `step ${step.name}: plan ${action.summary}`);
      return actions;
    },
    async apply(actions, run) {
      for (const action of actions) {
        io?.stdout(`${step.name}: ${action.summary}\n`);
        log.write("info", `step ${step.name}: apply ${action.summary}`);
      }
      await step.apply(actions, run);
    },
  }));
}

/** The exit code of an error a command did not expect: its own when it carries one, 2 for a configuration, else 1. */
export function exitCodeOf(error: unknown): ExitCode {
  if (error instanceof ConfigError) return ExitCode.InvalidUsage;
  const code = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof code === "number" ? (code as ExitCode) : ExitCode.RuntimeFailure;
}

export function describeError(error: unknown): string {
  if (error instanceof ConfigError) return `invalid configuration:\n${error.issues.map((issue) => `  ${issue}`).join("\n")}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a command body with a Docker session, and turns any error into its exit code with the redacted message on
 * stderr and in the run log.
 */
export async function withDockerSession(
  command: string,
  args: RunArgs,
  io: Output,
  body: (session: DockerSession) => Promise<ExitCode>,
): Promise<ExitCode> {
  let session: DockerSession | undefined;
  try {
    session = await openDockerSession(command, args);
    const code = await body(session);
    session.log.write("info", `${command} exited with ${code}`);
    return code;
  } catch (error) {
    const message = describeError(error);
    const code = exitCodeOf(error);
    const redacted = session === undefined ? message : session.redactor.redact(message);
    io.stderr(`${command}: ${redacted}\n`);
    session?.log.write("error", `${command} exited with ${code}: ${message}`);
    return code;
  } finally {
    session?.log.close();
  }
}
