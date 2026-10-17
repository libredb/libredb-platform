import { describe, expect, test } from "bun:test";
import {
  migrateReasons,
  migrationHistoryScript,
  parseMigrationHistory,
  type MigrateDecision,
} from "../../../src/platform/migrations";

const clean = { exists: true, failed: [], latest: "20261015110332_publish_contract_v1" };
const converged: MigrateDecision = { recordedInputHash: "a".repeat(64), inputHash: "a".repeat(64), envChanged: false, history: clean };

describe("migrationHistoryScript", () => {
  test("reads platform._prisma_migrations only when it exists, so a database before the first migrate answers too", () => {
    const script = migrationHistoryScript();
    expect(script).toContain("to_regclass('platform._prisma_migrations') IS NOT NULL AS history_exists \\gset");
    expect(script).toContain("\\if :history_exists");
    expect(script).toContain("m.finished_at IS NULL AND m.rolled_back_at IS NULL");
    expect(script).toContain("\\else");
    expect(script).toContain("'exists', false");
  });
});

describe("parseMigrationHistory", () => {
  test("reads the result line and ignores psql's other output", () => {
    const stdout = `libredb-result migrations ${JSON.stringify({ exists: true, failed: ["x"], latest: "y" })}\n`;
    expect(parseMigrationHistory(`notice\n${stdout}`)).toEqual({ exists: true, failed: ["x"], latest: "y" });
  });

  test("refuses output without the result", () => {
    expect(() => parseMigrationHistory("")).toThrow("the Platform migration history are malformed");
  });
});

describe("migrateReasons", () => {
  test("a converged installation plans no migrate", () => {
    expect(migrateReasons(converged)).toEqual([]);
  });

  test("runs the job when it has not succeeded yet, also after a failed run", () => {
    expect(
      migrateReasons({ ...converged, recordedInputHash: undefined, envChanged: true, history: { exists: false, failed: [], latest: null } }),
    ).toEqual(["it has not succeeded yet", "platform._prisma_migrations does not exist yet"]);
  });

  test("runs the job when its definition, such as the pinned image, or its env file changed", () => {
    expect(migrateReasons({ ...converged, inputHash: "b".repeat(64) })).toEqual(["its service definition changed"]);
    expect(migrateReasons({ ...converged, envChanged: true })).toEqual(["its env file changed"]);
  });

  test("runs the job when the history holds a failed migration, naming each", () => {
    expect(migrateReasons({ ...converged, history: { ...clean, failed: ["a"] } })).toEqual([
      "platform._prisma_migrations holds the failed migration a",
    ]);
    expect(migrateReasons({ ...converged, history: { ...clean, failed: ["a", "b"] } })).toEqual([
      "platform._prisma_migrations holds the failed migrations a, b",
    ]);
  });
});
