// Step 11 of the Docker graph: Platform's migrate job, run once with `docker compose run --rm` before any Platform
// container is recreated, with its migrate env of contracts/env-inventory.yaml in its own 0600 env file, the only file
// that holds MIGRATE_DATABASE_URL, so the running Platform never holds the owner role's credentials. A job that exits
// non-zero fails the step with exit 1 and its log, and the graph stops before platform-deploy, so the running Platform
// stays as it was. After a job that succeeded, the state gains a revision that records the SHA-256 of compose.yaml and
// of the migrate env file the job ran with, and the latest migration in platform._prisma_migrations.
import { applyFile, observePath } from "../adapters/host-fs";
import { planFile, type FileAction, type FileSpec, type ObservedPath } from "../docker/converge";
import { CA_BUNDLE_FILE } from "../docker/layout";
import { serviceDefinition } from "../docker/project";
import type { Action, Step } from "../engine/step";
import { renderPlatformMigrateEnv } from "../model/platform-env";
import { requireMigrateSuccess } from "../platform/migrate-outcome";
import {
  migrateReasons,
  migrationHistoryScript,
  parseMigrationHistory,
  type MigrationHistory,
} from "../platform/migrations";
import {
  COMPOSE_FILE,
  JOBS_PROFILE,
  PLATFORM_MIGRATE_ENV_FILE,
  PLATFORM_MIGRATE_SERVICE,
  renderComposeEnvFile,
} from "../render/compose";
import { ROLE_SPECS } from "../sql/provision";
import { runScript, type PsqlLogin } from "../sql/runner";
import { appendRevision } from "../state/store";
import { POSTGRES_DOCKER_SERVICE } from "../tls/plan";
import { COMPOSE_TARGET, composeFileSpec, projectContainers, renderedCompose } from "./deploy";
import { fileFingerprint, recordedInputHash, type DockerContext } from "./docker-context";
import { platformLogin, postgresServer, storedSecrets } from "./platform-deploy";
import { postgresRunner } from "./postgres-provision";

const SUMMARY = "run the Platform migrate job";

type MigrateAction = FileAction | (Action & { kind: "pending"; reason: string }) | (Action & { kind: "migrate" });

type MigrateObservation =
  | { pending: string }
  | { files: { spec: FileSpec; observed: ObservedPath | undefined }[]; history: MigrationHistory };

/** The job's env file and the login that reads the migration history, or why the job cannot run yet. */
async function migrateTarget(context: DockerContext): Promise<{ pending: string } | { env: FileSpec; login: PsqlLogin }> {
  const secrets = await storedSecrets(context, [ROLE_SPECS.owner.secret, ROLE_SPECS.platform.secret]);
  if ("pending" in secrets) return { pending: secrets.pending };
  if (observePath(CA_BUNDLE_FILE) === undefined) {
    return { pending: `${CA_BUNDLE_FILE} does not exist yet, so apply the base step first` };
  }
  if (context.desired.postgres.managed) {
    const postgres = (await projectContainers(context)).find((container) => container.service === POSTGRES_DOCKER_SERVICE);
    if (postgres?.state !== "running" || postgres.health !== "healthy") {
      return { pending: "the managed PostgreSQL is not running and healthy yet, so apply the postgres-deploy step first" };
    }
  }
  const platformPassword = secrets.value(ROLE_SPECS.platform.secret);
  const env = renderPlatformMigrateEnv(context.desired, {
    postgres: postgresServer(context),
    secrets: { databasePassword: platformPassword, ownerPassword: secrets.value(ROLE_SPECS.owner.secret) },
  });
  return {
    env: { path: PLATFORM_MIGRATE_ENV_FILE, content: renderComposeEnvFile(env), mode: 0o600, uid: 0, gid: 0 },
    login: platformLogin(postgresServer(context), platformPassword),
  };
}

/** Reads the migration history as libredb_platform, or why it cannot be read yet. */
async function readHistory(context: DockerContext, login: PsqlLogin): Promise<MigrationHistory> {
  const result = await runScript(postgresRunner(context), login, migrationHistoryScript());
  return parseMigrationHistory(result.stdout);
}

function fingerprintOf(path: string): string {
  const fingerprint = fileFingerprint(path);
  if (fingerprint === null) throw new Error(`${path} does not exist after the migrate job ran`);
  return fingerprint;
}

export const platformMigrateStep: Step<DockerContext, MigrateObservation, MigrateAction> = {
  name: "platform-migrate",
  // The job's definition carries the pinned image, so a new Platform release runs the job again.
  inputs: (context) => ({ service: serviceDefinition(renderedCompose(context.desired), PLATFORM_MIGRATE_SERVICE) }),
  async observe({ context }) {
    const target = await migrateTarget(context);
    if ("pending" in target) return target;
    const files = [composeFileSpec(context), target.env].map((spec) => ({ spec, observed: observePath(spec.path) }));
    let history: MigrationHistory;
    try {
      history = await readHistory(context, target.login);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const pending = "libredb_platform cannot read the migration history yet, so apply the postgres-provision step first";
      return { pending: `${pending}: ${reason}` };
    }
    return { files, history };
  },
  plan(observed, run) {
    if ("pending" in observed) return [{ kind: "pending", reason: observed.pending, summary: SUMMARY }];
    const actions: MigrateAction[] = observed.files.flatMap((file) => planFile(file.spec, file.observed));
    const reasons = migrateReasons({
      recordedInputHash: recordedInputHash(run.state, "platform-migrate"),
      inputHash: run.inputHash,
      envChanged: actions.some((action) => action.kind === "file" && action.file.path === PLATFORM_MIGRATE_ENV_FILE),
      history: observed.history,
    });
    if (reasons.length > 0) actions.push({ kind: "migrate", summary: `${SUMMARY}: ${reasons.join("; ")}` });
    return actions;
  },
  async apply(actions, { context, state }) {
    for (const action of actions) {
      if (action.kind === "pending") throw new Error(`cannot ${action.summary}: ${action.reason}`);
      if (action.kind === "file") applyFile(action.file);
    }
    if (!actions.some((action) => action.kind === "migrate")) return;
    const job = await context.docker.runJob(COMPOSE_TARGET, PLATFORM_MIGRATE_SERVICE, { profile: JOBS_PROFILE });
    requireMigrateSuccess({ exitCode: job.exitCode, output: `${job.stdout}${job.stderr}` });
    const target = await migrateTarget(context);
    if ("pending" in target) throw new Error(`cannot read the migration history after the migrate job: ${target.pending}`);
    const history = await readHistory(context, target.login);
    appendRevision(state, {
      createdAt: context.now().toISOString(),
      rendered: {
        [COMPOSE_FILE]: fingerprintOf(COMPOSE_FILE),
        [PLATFORM_MIGRATE_ENV_FILE]: fingerprintOf(PLATFORM_MIGRATE_ENV_FILE),
      },
      ...(history.latest === null ? {} : { platformMigration: history.latest }),
    });
  },
};
