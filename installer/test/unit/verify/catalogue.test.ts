import { describe, expect, test } from "bun:test";
import {
  CATALOGUE,
  formatResults,
  runChecks,
  verifyExitCode,
  type Check,
} from "../../../src/verify/catalogue";

interface FakeContext {
  calls: string[];
}

const checks: Check<FakeContext>[] = [
  {
    id: "first-passes",
    async run(context) {
      context.calls.push("first-passes");
      return { passed: true };
    },
  },
  {
    id: "second-fails",
    async run(context) {
      context.calls.push("second-fails");
      return { passed: false, cause: "libredb_platform has no USAGE on schema studio is false" };
    },
  },
  {
    id: "third-throws",
    async run(context) {
      context.calls.push("third-throws");
      throw new Error("psql exited with code 2: connection refused");
    },
  },
];

describe("verify catalogue", () => {
  test("the JSON output lists every check with id, result and cause, and one failed check makes the exit code 4", async () => {
    const context: FakeContext = { calls: [] };
    const results = await runChecks(checks, context);
    expect(context.calls).toEqual(["first-passes", "second-fails", "third-throws"]);
    expect(JSON.parse(formatResults(results, "json"))).toEqual({
      checks: [
        { id: "first-passes", result: "passed", cause: null },
        { id: "second-fails", result: "failed", cause: "libredb_platform has no USAGE on schema studio is false" },
        { id: "third-throws", result: "failed", cause: "psql exited with code 2: connection refused" },
      ],
    });
    expect(verifyExitCode(results)).toBe(4);
    expect(verifyExitCode(results.slice(0, 1))).toBe(0);
  });

  test("the text output prints one line per check and a summary", async () => {
    const results = await runChecks(checks, { calls: [] });
    expect(formatResults(results, "text")).toBe(
      [
        "passed  first-passes",
        "failed  second-fails: libredb_platform has no USAGE on schema studio is false",
        "failed  third-throws: psql exited with code 2: connection refused",
        "2 of 3 checks failed",
        "",
      ].join("\n"),
    );
    expect(formatResults(results.slice(0, 1), "text")).toBe("passed  first-passes\n1 check passed\n");
  });

  test("a check that throws a value other than an Error fails with that value as its cause", async () => {
    const odd: Check<null> = {
      id: "odd",
      run: () => Promise.reject("plain text"),
    };
    expect(await runChecks([odd], null)).toEqual([{ id: "odd", result: "failed", cause: "plain text" }]);
  });

  test("a warning is reported with its cause, and a run with warnings and no failure exits 0", async () => {
    const warns: Check<null> = {
      id: "admin-mfa",
      run: async () => ({ passed: true, warning: "1 account holds libredb:admin without an OTP credential" }),
    };
    const pass: Check<null> = { id: "edge-tls", run: async () => ({ passed: true }) };
    const fail: Check<null> = { id: "clock-skew", run: async () => ({ passed: false, cause: "Keycloak is 20 s ahead" }) };
    const results = await runChecks([pass, warns], null);
    expect(JSON.parse(formatResults(results, "json"))).toEqual({
      checks: [
        { id: "edge-tls", result: "passed", cause: null },
        { id: "admin-mfa", result: "warning", cause: "1 account holds libredb:admin without an OTP credential" },
      ],
    });
    expect(verifyExitCode(results)).toBe(0);
    expect(formatResults(results, "text")).toBe(
      [
        "passed  edge-tls",
        "warning admin-mfa: 1 account holds libredb:admin without an OTP credential",
        "2 checks passed, 1 with a warning",
        "",
      ].join("\n"),
    );
    const failing = await runChecks([fail, warns], null);
    expect(verifyExitCode(failing)).toBe(4);
    expect(formatResults(failing, "text").split("\n").at(-2)).toBe("1 of 2 checks failed, 1 with a warning");
  });

  test("what a check found reaches its result and the JSON output, and the text output prints only the result and cause", async () => {
    const free = "none, so Platform runs on the free tier of 1 admin and 3 users";
    const found: Check<null> = { id: "platform-license", run: async () => ({ passed: true, detail: free }) };
    const expiring: Check<null> = {
      id: "expiring",
      run: async () => ({ passed: true, warning: "the license expires within 30 days", detail: "expiring" }),
    };
    const expired: Check<null> = {
      id: "expired",
      run: async () => ({ passed: false, cause: "the license expired", detail: "expired" }),
    };
    const results = await runChecks([found, expiring, expired], null);
    expect(results).toEqual([
      { id: "platform-license", result: "passed", cause: null, detail: free },
      { id: "expiring", result: "warning", cause: "the license expires within 30 days", detail: "expiring" },
      { id: "expired", result: "failed", cause: "the license expired", detail: "expired" },
    ]);
    expect(JSON.parse(formatResults(results, "json"))).toEqual({ checks: results });
    expect(formatResults(results, "text")).toBe(
      [
        "passed  platform-license",
        "warning expiring: the license expires within 30 days",
        "failed  expired: the license expired",
        "1 of 3 checks failed, 1 with a warning",
        "",
      ].join("\n"),
    );
  });

  test("the catalogue starts with postgres-privileges, ends with admin-mfa and holds every check id once", () => {
    const ids = CATALOGUE.map((check) => check.id);
    expect(ids[0]).toBe("postgres-privileges");
    expect(ids.at(-1)).toBe("admin-mfa");
    expect(new Set(ids).size).toBe(ids.length);
  });
});
