import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGUE, runChecks } from "../../../src/verify/catalogue";
import { PLATFORM_CHECKS } from "../../../src/verify/platform";
import {
  LICENSE_LOG_WINDOW_MS,
  licenseStartLine,
  platformLicenseCheck,
  startLogWindow,
  type PlatformLicenseContext,
  type PlatformStartLog,
} from "../../../src/verify/platform-license";

// Platform's license module, whose start line and day boundaries the check copies.
const PLATFORM_LICENSE_SOURCES = join(import.meta.dir, "..", "..", "..", "..", "src", "shared", "lib", "license");

const FILE = "/etc/libredb/platform.license";
const STARTED_AT = "2026-10-17T10:00:00.123456789Z";
const EXPIRES_AT = "2027-10-16T00:00:00.000Z";
const EXPIRES_MS = Date.parse(EXPIRES_AT);
const GRACE_ENDS_AT = "2027-10-30T00:00:00.000Z";
const DAY_MS = 86_400_000;
const NO_SEAT = "so Platform adds no user, connection or admin until a valid license is installed";
const RENEWAL = `renew it at info@libredb.org, replace ${FILE} with the renewed license and run apply`;

// The license lines as Platform's logger prints them in production, recorded with createLogger("info", "json") of
// src/shared/lib/logger.ts and the fields of logLicenseStatus in src/shared/lib/license/install-license.ts.
const RECORDED = {
  invalid: (code: string) =>
    `{"level":"warn","message":"License invalid, no seat can be added","timestamp":"2026-10-17T10:00:01.383Z","state":"invalid","code":"${code}"}`,
  active:
    '{"level":"info","message":"License active","timestamp":"2026-10-17T10:00:01.383Z","state":"active",' +
    `"licenseId":"LDL-2026-0001","customer":"Acme Corp","expiresAt":"${EXPIRES_AT}"}`,
  expiring:
    '{"level":"warn","message":"License expiring within 30 days","timestamp":"2026-10-17T10:00:01.383Z","state":"expiring",' +
    `"licenseId":"LDL-2026-0001","customer":"Acme Corp","expiresAt":"${EXPIRES_AT}"}`,
};

/**
 * What a Platform container prints in the first minutes of a run: the lines of Next.js's start banner, here without its
 * symbols, around Platform's own JSON lines.
 */
function startOutput(...lines: string[]): string {
  return [
    "   Next.js 16.2.1",
    "   - Local:        http://localhost:3000",
    "",
    " Starting...",
    ...lines,
    '{"level":"info","message":"Scheduler started","timestamp":"2026-10-17T10:00:01.391Z","tasks":["query-event-retention"]}',
    " Ready in 412ms",
    "",
  ].join("\n");
}

const started = (text: string): PlatformStartLog => ({ startedAt: STARTED_AT, text });

function context(
  overrides: Partial<PlatformLicenseContext> = {},
  log: PlatformStartLog = started(startOutput(RECORDED.active)),
): { license: PlatformLicenseContext; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    license: {
      licenseFile: FILE,
      platformUrl: "https://platform.libredb.test",
      startLog: async () => {
        reads.push("start-log");
        return log;
      },
      now: () => Date.parse("2026-10-17T12:00:00.000Z"),
      ...overrides,
    },
  };
}

const at = (ms: number) => () => ms;

describe("platform-license", () => {
  test("an active license passes with its id, customer and expiry, read from the line Platform logged at its start", async () => {
    const checks = context();
    expect(await platformLicenseCheck.run(checks)).toEqual({
      passed: true,
      detail: `LDL-2026-0001 for Acme Corp, active, expires at ${EXPIRES_AT}`,
    });
    expect(checks.reads).toEqual(["start-log"]);
  });

  test("an invalid token fails naming its code and what it means, and that Platform adds no user, connection or admin until a valid license is installed", async () => {
    const run = (code: string) => platformLicenseCheck.run(context({}, started(startOutput(RECORDED.invalid(code)))));
    expect(await run("LICENSE_HOST_MISMATCH")).toEqual({
      passed: false,
      cause:
        `the license token in ${FILE} fails Platform's verification with LICENSE_HOST_MISMATCH, because the license ` +
        `lists hosts, and platform.libredb.test, the host of AUTH_URL, is not one of them, ${NO_SEAT}`,
      detail: "invalid, LICENSE_HOST_MISMATCH, no seat can be added",
    });
    expect(await run("LICENSE_UNKNOWN_KID")).toEqual({
      passed: false,
      cause:
        `the license token in ${FILE} fails Platform's verification with LICENSE_UNKNOWN_KID, because a key that this ` +
        `Platform build does not hold signed it, ${NO_SEAT}`,
      detail: "invalid, LICENSE_UNKNOWN_KID, no seat can be added",
    });
    // A code that this installer does not know is named as Platform logged it.
    expect(await run("LICENSE_FROM_THE_FUTURE")).toEqual({
      passed: false,
      cause: `the license token in ${FILE} fails Platform's verification with LICENSE_FROM_THE_FUTURE, ${NO_SEAT}`,
      detail: "invalid, LICENSE_FROM_THE_FUTURE, no seat can be added",
    });
  });

  test("every verification failure code of Platform's errors.ts has a meaning in the cause", async () => {
    const errors = readFileSync(join(PLATFORM_LICENSE_SOURCES, "errors.ts"), "utf8");
    const codes = [...errors.matchAll(/^ {2}'(LICENSE_[A-Z_]+)',$/gm)].map((match) => match[1] ?? "");
    expect(codes).toEqual([
      "LICENSE_MALFORMED",
      "LICENSE_UNKNOWN_KID",
      "LICENSE_BAD_SIGNATURE",
      "LICENSE_PAYLOAD_INVALID",
      "LICENSE_HOST_MISMATCH",
    ]);
    for (const code of codes) {
      const outcome = await platformLicenseCheck.run(context({}, started(startOutput(RECORDED.invalid(code)))));
      expect({ code, explained: !outcome.passed && outcome.cause.includes(`with ${code}, because `) }).toEqual({
        code,
        explained: true,
      });
    }
  });

  test("a start line of the state free, which Platform no longer has, fails naming the states the check accepts", async () => {
    // Platform 1.0.0 logged this state when it started without a license, which every install now needs.
    const free = '{"level":"info","message":"No license","timestamp":"2026-10-17T10:00:01.383Z","state":"free"}';
    expect(await runChecks([platformLicenseCheck], context({}, started(startOutput(free))))).toEqual([
      {
        id: "platform-license",
        result: "failed",
        cause:
          "the fields of Platform's license line are malformed: state: Invalid option: expected one of " +
          '"invalid"|"active"|"expiring"|"grace"|"expired"',
      },
    ]);
  });

  test("the state of a valid license follows its expiry and the installer clock, as Platform computes it on every read", async () => {
    const run = (nowMs: number, log?: PlatformStartLog) => platformLicenseCheck.run(context({ now: at(nowMs) }, log));
    // The last millisecond before the 30 days before the expiry, and the first one of them.
    expect(await run(EXPIRES_MS - 30 * DAY_MS - 1)).toEqual({
      passed: true,
      detail: `LDL-2026-0001 for Acme Corp, active, expires at ${EXPIRES_AT}`,
    });
    expect(await run(EXPIRES_MS - 30 * DAY_MS)).toEqual({
      passed: true,
      warning: `the license LDL-2026-0001 for Acme Corp expires at ${EXPIRES_AT}, within 30 days: ${RENEWAL}`,
      detail: `LDL-2026-0001 for Acme Corp, expiring, expires at ${EXPIRES_AT}`,
    });
    // Platform logged expiring at its start, and the clock has since passed the expiry: the grace period.
    expect(await run(EXPIRES_MS, started(startOutput(RECORDED.expiring)))).toEqual({
      passed: true,
      warning:
        `the license LDL-2026-0001 for Acme Corp expired at ${EXPIRES_AT}, and its seats apply only until ` +
        `${GRACE_ENDS_AT}, the end of its 14-day grace period: ${RENEWAL}`,
      detail: `LDL-2026-0001 for Acme Corp, expired at ${EXPIRES_AT}, in its grace period until ${GRACE_ENDS_AT}`,
    });
    expect(await run(EXPIRES_MS + 14 * DAY_MS - 1)).toMatchObject({ passed: true, detail: expect.stringContaining("grace period") });
    expect(await run(EXPIRES_MS + 14 * DAY_MS)).toEqual({
      passed: false,
      cause:
        `the license LDL-2026-0001 for Acme Corp expired at ${EXPIRES_AT}, and its grace period ended at ${GRACE_ENDS_AT}, ` +
        `so Platform adds no user, connection or admin: ${RENEWAL}`,
      detail: `LDL-2026-0001 for Acme Corp, expired at ${EXPIRES_AT}, no seat can be added`,
    });
  });

  test("a log that no longer reaches Platform's start, which Docker drops from a long log, warns that the license was not checked", async () => {
    expect(await platformLicenseCheck.run(context({}, started("")))).toEqual({
      passed: true,
      warning:
        `not checked, because Platform's container log no longer holds what Platform printed after its start at ` +
        `${STARTED_AT}, as Docker drops the oldest lines of a long log; https://platform.libredb.test/admin/license ` +
        "shows the license state",
      detail: "unknown, Platform's log no longer holds its license line",
    });
  });

  test("a log of Platform's start without a license line fails pointing to the Platform log", async () => {
    expect(await platformLicenseCheck.run(context({}, started(startOutput())))).toEqual({
      passed: false,
      cause:
        `Platform printed no license line within 5 minutes of its start at ${STARTED_AT}, so its license state is ` +
        "unknown; the Platform log has the full output: docker compose -p libredb logs platform",
    });
  });

  test("a failed read of Platform's log fails the check with the error", async () => {
    const checks = context({ startLog: () => Promise.reject(new Error("docker logs exited with code 1: No such container")) });
    expect(await runChecks([platformLicenseCheck], checks)).toEqual([
      { id: "platform-license", result: "failed", cause: "docker logs exited with code 1: No such container" },
    ]);
  });
});

describe("licenseStartLine", () => {
  test("finds the license line among Next.js's banner and Platform's other lines", () => {
    expect(licenseStartLine(startOutput(RECORDED.invalid("LICENSE_BAD_SIGNATURE")))).toEqual({
      state: "invalid",
      code: "LICENSE_BAD_SIGNATURE",
    });
    expect(licenseStartLine(startOutput())).toBeUndefined();
    expect(licenseStartLine("")).toBeUndefined();
  });

  test("ignores JSON that is not a license line: values that are not objects, other messages, and lines without a state", () => {
    const text = [
      "null",
      "42",
      '"License active"',
      '{"level":"info","message":"Seal canary published","state":"active"}',
      '{"level":"warn","message":"License page: the Keycloak directory is unreachable","userId":"u1"}',
      '{"level":"error","message":"Reading the license failed","error":{"message":"bad key list"}}',
    ].join("\n");
    expect(licenseStartLine(text)).toBeUndefined();
  });

  test("takes the last license line when a log holds more than one", () => {
    expect(licenseStartLine(startOutput(RECORDED.invalid("LICENSE_UNKNOWN_KID"), RECORDED.active))?.state).toBe("active");
  });

  test("a license line without the fields of its state is refused naming each field, never its value", () => {
    const line = '{"level":"info","message":"License active","state":"active","id":"LDL-2026-0001","expiresAt":"soon"}';
    let message = "";
    try {
      licenseStartLine(line);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith("the fields of Platform's license line are malformed: licenseId: ");
    expect(message).toContain("; customer: ");
    expect(message).toContain("; expiresAt: ");
    expect(message).not.toContain("soon");
  });
});

describe("startLogWindow", () => {
  test("covers the 5 minutes after the start Docker reports, which hold the line Platform logs before it serves", () => {
    expect(LICENSE_LOG_WINDOW_MS).toBe(5 * 60_000);
    expect(startLogWindow(STARTED_AT)).toEqual({ since: STARTED_AT, until: "2026-10-17T10:05:00.123Z" });
  });

  test("refuses a start that is not a time", () => {
    expect(() => startLogWindow("")).toThrow("Docker reports the start of Platform's container as '', which is not a time");
  });
});

describe("the facts the check copies from Platform", () => {
  test("Platform logs one line per state with a message about the license, and the fields the check reads", () => {
    const source = readFileSync(join(PLATFORM_LICENSE_SOURCES, "install-license.ts"), "utf8");
    const lines = [...source.matchAll(/^ {2}(\w+): \{ level: '(?:info|warn)', message: '([^']+)' \},$/gm)];
    expect(lines.map((match) => match[1])).toEqual(["invalid", "active", "expiring", "grace", "expired"]);
    for (const match of lines) expect(match[2]).toMatch(/licen[cs]e/i);
    for (const field of [
      "if (status.state === 'invalid') return { state: status.state, code: status.code }",
      "licenseId: status.license.id,",
      "customer: status.license.customer,",
      "expiresAt: new Date(status.license.expiresAt * 1000).toISOString(),",
    ]) {
      expect(source).toContain(field);
    }
  });

  test("a valid license warns from 30 days before its expiry and has 14 days of grace", () => {
    const source = readFileSync(join(PLATFORM_LICENSE_SOURCES, "state.ts"), "utf8");
    expect(source).toContain("const WARNING_DAYS = 30\n");
    expect(source).toContain("const GRACE_DAYS = 14\n");
  });
});

describe("platform-license in the catalogue", () => {
  test("verify runs it right after the Platform checks, once Platform has started", () => {
    const ids = CATALOGUE.map((check) => check.id);
    const last = PLATFORM_CHECKS.at(-1)?.id ?? "";
    expect(ids.indexOf("platform-license")).toBe(ids.indexOf(last) + 1);
  });
});
