// Reads the outcome of Platform's migrate job: exit 0 passes, and any other exit fails the step with exit 1 and the
// job log. When Prisma reports a failed migration (P3009, or P3018 for one that failed in this run), the error also
// prints the image's migrate-status and migrate-resolve commands that repair the history, as the P3009 recovery of
// docs/deploy/platform-runtime.md describes.
import { ExitCode } from "../cli/exit-codes";
import { COMPOSE_FILE, COMPOSE_PROJECT, JOBS_PROFILE, PLATFORM_MIGRATE_SERVICE } from "../render/compose";

/** What `docker compose run` of the job returned: the job's exit code and its redacted output. */
export interface MigrateJobResult {
  exitCode: number;
  output: string;
}

/** The command that runs the migrate job's service of the installed compose file, with the given image arguments. */
export function migrateJobCommand(...args: string[]): string {
  return [
    "docker compose -p",
    COMPOSE_PROJECT,
    "-f",
    COMPOSE_FILE,
    "--profile",
    JOBS_PROFILE,
    "run --rm",
    PLATFORM_MIGRATE_SERVICE,
    ...args,
  ].join(" ");
}

// Prisma's P3009 names each failed migration of the history; P3018 names the one that failed in this run.
const P3009_MIGRATION = /^The `([^`]+)` migration started at .* failed$/gm;
const P3018_MIGRATION = /^Migration name: (\S+)$/gm;

/** The failed migrations Prisma names in the job log, each once and in the order it names them. */
export function failedMigrations(output: string): string[] {
  const names: string[] = [];
  if (/\bP3009\b/.test(output)) names.push(...[...output.matchAll(P3009_MIGRATION)].map((match) => match[1] as string));
  if (/\bP3018\b/.test(output)) names.push(...[...output.matchAll(P3018_MIGRATION)].map((match) => match[1] as string));
  return [...new Set(names)];
}

/** The migrate job exited with an error. Its message holds the job log, which the exec adapter already redacted. */
export class PlatformMigrateError extends Error {
  readonly exitCode = ExitCode.RuntimeFailure;
  /** The failed migrations Prisma named, for which the message prints the repair commands. */
  readonly failed: readonly string[];

  constructor(message: string, failed: readonly string[]) {
    super(message);
    this.name = "PlatformMigrateError";
    this.failed = failed;
  }
}

function repairCommands(failed: readonly string[]): string[] {
  if (failed.length === 0) return [];
  return [
    `Prisma reports the failed migration${failed.length === 1 ? "" : "s"} ${failed.join(", ")}, ` +
      "so no migration runs until the history is repaired.",
    "Show the state of every migration:",
    `  ${migrateJobCommand("migrate-status")}`,
    "Once the database holds none of a failed migration's changes, mark it rolled back, and the next apply runs it again:",
    ...failed.map((name) => `  ${migrateJobCommand("migrate-resolve", "--rolled-back", name)}`),
    "Or, once its changes are complete in the database, mark it applied:",
    ...failed.map((name) => `  ${migrateJobCommand("migrate-resolve", "--applied", name)}`),
  ];
}

/** Throws PlatformMigrateError, exit 1, unless the job exited 0. */
export function requireMigrateSuccess(result: MigrateJobResult): void {
  if (result.exitCode === 0) return;
  const log = result.output.trimEnd();
  const failed = failedMigrations(log);
  const lines =
    log === ""
      ? [`the Platform migrate job exited with code ${result.exitCode} and printed nothing`]
      : [
          `the Platform migrate job exited with code ${result.exitCode}, so no Platform container was changed. Job log:`,
          ...log.split("\n").map((line) => `  | ${line}`),
        ];
  throw new PlatformMigrateError([...lines, ...repairCommands(failed)].join("\n"), failed);
}
