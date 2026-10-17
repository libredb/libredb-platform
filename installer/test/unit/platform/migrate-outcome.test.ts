import { describe, expect, test } from "bun:test";
import {
  failedMigrations,
  migrateJobCommand,
  PlatformMigrateError,
  requireMigrateSuccess,
} from "../../../src/platform/migrate-outcome";

// What the Prisma CLI of the Platform image prints when the history holds a failed migration.
const P3009_LOG = [
  "preflight: every check passed",
  "Prisma schema loaded from schema.prisma",
  'Datasource "db": PostgreSQL database "libredb", schemas "platform" at "postgres:5432"',
  "",
  "13 migrations found in prisma/migrations",
  "",
  "Error: P3009",
  "",
  "migrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve",
  "The `20261015235959_e2e_failed` migration started at 2026-10-15 11:42:11.123 UTC failed",
  "",
].join("\n");

const COMPOSE_RUN = "docker compose -p libredb -f /opt/libredb/compose.yaml --profile jobs run --rm platform-migrate";

function failureOf(output: string, exitCode = 1): PlatformMigrateError {
  try {
    requireMigrateSuccess({ exitCode, output });
  } catch (error) {
    if (error instanceof PlatformMigrateError) return error;
    throw error;
  }
  throw new Error("requireMigrateSuccess accepted a failed job");
}

describe("requireMigrateSuccess", () => {
  test("a migrate log containing P3009 fails with exit 1 and prints the migrate-status and migrate-resolve commands", () => {
    const error = failureOf(P3009_LOG);
    expect(error.exitCode).toBe(1);
    expect(error.failed).toEqual(["20261015235959_e2e_failed"]);
    expect(error.message).toContain("the Platform migrate job exited with code 1");
    // The job log, so the operator sees Prisma's own words.
    expect(error.message).toContain("Error: P3009");
    expect(error.message).toContain(`${COMPOSE_RUN} migrate-status`);
    expect(error.message).toContain(`${COMPOSE_RUN} migrate-resolve --rolled-back 20261015235959_e2e_failed`);
    expect(error.message).toContain(`${COMPOSE_RUN} migrate-resolve --applied 20261015235959_e2e_failed`);
  });

  test("a job that exits 0 passes", () => {
    expect(() => requireMigrateSuccess({ exitCode: 0, output: "preflight: every check passed\n" })).not.toThrow();
  });

  test("a migration that fails in this run (P3018) also prints the commands for the migration it names", () => {
    const error = failureOf(
      [
        "Error: P3018",
        "",
        "A migration failed to apply. New migrations cannot be applied before the error is recovered from.",
        "",
        "Migration name: 20261015110332_publish_contract_v1",
        "",
        "Database error code: 42501",
      ].join("\n"),
    );
    expect(error.failed).toEqual(["20261015110332_publish_contract_v1"]);
    expect(error.message).toContain(`${COMPOSE_RUN} migrate-resolve --rolled-back 20261015110332_publish_contract_v1`);
  });

  test("another failure fails with exit 1 and the job log, without the resolve commands", () => {
    const error = failureOf(
      "preflight check failed: the runtime roles libredb_platform and libredb_studio exist: missing libredb_studio\n",
      1,
    );
    expect(error.exitCode).toBe(1);
    expect(error.failed).toEqual([]);
    expect(error.message).toContain("missing libredb_studio");
    expect(error.message).not.toContain("migrate-resolve");
  });

  test("an empty job log is named as empty", () => {
    expect(failureOf("", 137).message).toContain("the Platform migrate job exited with code 137 and printed nothing");
  });
});

describe("failedMigrations", () => {
  test("names every failed migration once, in the order Prisma lists them", () => {
    const output = [
      "Error: P3009",
      "The `20261015000001_a` migration started at 2026-10-15 10:00:00 UTC failed",
      "The `20261015000002_b` migration started at 2026-10-15 10:00:01 UTC failed",
      "The `20261015000001_a` migration started at 2026-10-15 10:00:00 UTC failed",
    ].join("\n");
    expect(failedMigrations(output)).toEqual(["20261015000001_a", "20261015000002_b"]);
    // Without one of Prisma's failed-migration codes the same words name nothing.
    expect(failedMigrations("The `x` migration started at 2026 failed\nMigration name: y\n")).toEqual([]);
  });
});

describe("migrateJobCommand", () => {
  test("runs the job service of the installed compose file with the given arguments", () => {
    expect(migrateJobCommand()).toBe(COMPOSE_RUN);
    expect(migrateJobCommand("migrate-status")).toBe(`${COMPOSE_RUN} migrate-status`);
  });
});
