// What the platform-migrate step reads from platform._prisma_migrations as libredb_platform, which may read it
// (Platform's readiness reads it too), and when the step runs the migrate job: when it has not succeeded yet, when its
// service definition or env file changed, or when the history is missing or holds a failed migration. A converged
// installation plans nothing, so an unchanged re-run never starts the job.
import { z } from "zod";
import { parseResult, parseResults, resultQuery } from "../sql/runner";

export interface MigrationHistory {
  /** Whether platform._prisma_migrations exists; the first migrate creates it. */
  exists: boolean;
  /** Migrations Prisma started and neither finished nor rolled back, which stop every later migrate (P3009). */
  failed: string[];
  /** The newest migration that finished and was not rolled back, or null. */
  latest: string | null;
}

const history = z
  .object({ exists: z.boolean(), failed: z.array(z.string()), latest: z.string().nullable() })
  .strict();

/** Prints the history as the result `migrations`, also before the first migrate created schema platform. */
export function migrationHistoryScript(): string {
  return [
    "SELECT to_regclass('platform._prisma_migrations') IS NOT NULL AS history_exists \\gset",
    "\\if :history_exists",
    resultQuery(
      "migrations",
      `jsonb_build_object('exists', true,
  'failed', (SELECT coalesce(jsonb_agg(m.migration_name ORDER BY m.migration_name), '[]') FROM platform._prisma_migrations m
    WHERE m.finished_at IS NULL AND m.rolled_back_at IS NULL),
  'latest', (SELECT max(m.migration_name) FROM platform._prisma_migrations m
    WHERE m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL))`,
    ),
    "\\else",
    resultQuery("migrations", "jsonb_build_object('exists', false, 'failed', '[]'::jsonb, 'latest', NULL)"),
    "\\endif",
    "",
  ].join("\n");
}

export function parseMigrationHistory(stdout: string): MigrationHistory {
  return parseResult(history, parseResults(stdout).get("migrations"), "Platform migration history");
}

export interface MigrateDecision {
  /** The input hash the step recorded when it last succeeded, or undefined when it never did or its last run failed. */
  recordedInputHash: string | undefined;
  inputHash: string;
  /** Whether the job's env file differs from the one this run renders. */
  envChanged: boolean;
  history: MigrationHistory;
}

/** Why the migrate job must run; none when it already ran with this definition and env and the history is clean. */
export function migrateReasons(decision: MigrateDecision): string[] {
  const reasons: string[] = [];
  if (decision.recordedInputHash === undefined) {
    reasons.push("it has not succeeded yet");
  } else {
    if (decision.recordedInputHash !== decision.inputHash) reasons.push("its service definition changed");
    if (decision.envChanged) reasons.push("its env file changed");
  }
  if (!decision.history.exists) reasons.push("platform._prisma_migrations does not exist yet");
  const { failed } = decision.history;
  if (failed.length > 0) {
    reasons.push(`platform._prisma_migrations holds the failed migration${failed.length === 1 ? "" : "s"} ${failed.join(", ")}`);
  }
  return reasons;
}
