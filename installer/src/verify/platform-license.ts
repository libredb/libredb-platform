// The license check of `verify`. Platform verifies PLATFORM_LICENSE as it starts and logs the outcome in one JSON line
// (logLicenseStatus in src/shared/lib/license/install-license.ts of Platform): the state, with the code of a token that
// fails verification or the id, customer and expiry of a valid license, and never the token. The check reads that line
// from what Platform's container printed in the first minutes of its current run, and the state of a valid license
// from its expiry and the installer clock, as Platform computes it on every read.
import { z } from "zod";
import { COMPOSE_PROJECT, PLATFORM_SERVICE } from "../render/compose";
import { parseResult } from "../sql/runner";
import type { Check, CheckOutcome } from "./catalogue";

/** How long after its start Platform has logged its license line, which it logs before it serves a request. */
export const LICENSE_LOG_WINDOW_MS = 5 * 60_000;

/** What Platform's container printed, standard output and standard error, within LICENSE_LOG_WINDOW_MS of a start. */
export interface PlatformStartLog {
  /** The start of the container's current run, as Docker reports State.StartedAt. */
  startedAt: string;
  text: string;
}

export interface PlatformLicenseContext {
  /** platform.licenseFile, which every configuration names. */
  licenseFile: string;
  /** Platform's public base URL, AUTH_URL, whose host a license that lists hosts must name. */
  platformUrl: string;
  /** What Platform printed after the start of its current run. */
  startLog: () => Promise<PlatformStartLog>;
  /** The installer's clock, in epoch milliseconds. */
  now: () => number;
}

type PlatformLicenseChecks = { license: PlatformLicenseContext };

/** The `docker logs --since` and `--until` of the window after a start, which Docker gives as State.StartedAt. */
export function startLogWindow(startedAt: string): { since: string; until: string } {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) throw new Error(`Docker reports the start of Platform's container as '${startedAt}', which is not a time`);
  return { since: startedAt, until: new Date(start + LICENSE_LOG_WINDOW_MS).toISOString() };
}

const VALID_STATES = ["active", "expiring", "grace", "expired"] as const;

// The fields of the license line that the check reads; Platform also logs the level, the message and the time.
const startLine = z.discriminatedUnion(
  "state",
  [
    z.object({ state: z.literal("invalid"), code: z.string() }),
    z.object({ state: z.enum(VALID_STATES), licenseId: z.string(), customer: z.string(), expiresAt: z.iso.datetime() }),
  ],
  {
    error: (issue) =>
      issue.code === "invalid_union"
        ? `Invalid option: expected one of ${["invalid", ...VALID_STATES].map((state) => `"${state}"`).join("|")}`
        : undefined,
  },
);

export type LicenseStartLine = z.output<typeof startLine>;

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The last license line of a log: a JSON line whose message is about the license and which carries a state. Such a
 * line without the fields of its state is refused, naming each field and never its value.
 */
export function licenseStartLine(log: string): LicenseStartLine | undefined {
  let found: LicenseStartLine | undefined;
  for (const text of log.split("\n")) {
    const entry = jsonObject(text);
    if (entry === undefined || typeof entry.state !== "string") continue;
    if (typeof entry.message !== "string" || !/licen[cs]e/i.test(entry.message)) continue;
    found = parseResult(startLine, entry, "fields of Platform's license line");
  }
  return found;
}

/** Why Platform refuses a token, as docs/deploy/platform-runtime.md gives each code of its errors.ts. */
function codeMeaning(code: string, platformUrl: string): string | undefined {
  if (code === "LICENSE_MALFORMED") return "it is not a well-formed license token";
  if (code === "LICENSE_UNKNOWN_KID") return "a key that this Platform build does not hold signed it";
  if (code === "LICENSE_BAD_SIGNATURE") return "its signature does not verify";
  if (code === "LICENSE_PAYLOAD_INVALID") return "it carries no valid license";
  if (code === "LICENSE_HOST_MISMATCH") {
    return `the license lists hosts, and ${new URL(platformUrl).hostname}, the host of AUTH_URL, is not one of them`;
  }
  return undefined;
}

const DAY_MS = 86_400_000;
/** Platform's WARNING_DAYS and GRACE_DAYS (src/shared/lib/license/state.ts). */
const EXPIRING_DAYS = 30;
const GRACE_DAYS = 14;

/** The state of a valid license at `nowMs`; each boundary belongs to the state it begins, as in Platform. */
function validState(expiresAtMs: number, nowMs: number): (typeof VALID_STATES)[number] {
  if (nowMs < expiresAtMs - EXPIRING_DAYS * DAY_MS) return "active";
  if (nowMs < expiresAtMs) return "expiring";
  if (nowMs < expiresAtMs + GRACE_DAYS * DAY_MS) return "grace";
  return "expired";
}

/** The outcome of a valid license from the license file `file`, from its state at `nowMs`. */
function validOutcome(line: Extract<LicenseStartLine, { licenseId: string }>, file: string, nowMs: number): CheckOutcome {
  const { licenseId, customer, expiresAt } = line;
  const expiresAtMs = Date.parse(expiresAt);
  const graceEndsAt = new Date(expiresAtMs + GRACE_DAYS * DAY_MS).toISOString();
  const named = `the license ${licenseId} for ${customer}`;
  const renewal = `renew it at info@libredb.org, replace ${file} with the renewed license and run apply`;
  switch (validState(expiresAtMs, nowMs)) {
    case "active":
      return { passed: true, detail: `${licenseId} for ${customer}, active, expires at ${expiresAt}` };
    case "expiring":
      return {
        passed: true,
        warning: `${named} expires at ${expiresAt}, within ${EXPIRING_DAYS} days: ${renewal}`,
        detail: `${licenseId} for ${customer}, expiring, expires at ${expiresAt}`,
      };
    case "grace":
      return {
        passed: true,
        warning:
          `${named} expired at ${expiresAt}, and its seats apply only until ${graceEndsAt}, ` +
          `the end of its ${GRACE_DAYS}-day grace period: ${renewal}`,
        detail: `${licenseId} for ${customer}, expired at ${expiresAt}, in its grace period until ${graceEndsAt}`,
      };
    case "expired":
      return {
        passed: false,
        cause:
          `${named} expired at ${expiresAt}, and its grace period ended at ${graceEndsAt}, ` +
          `so Platform adds no user, connection or admin: ${renewal}`,
        detail: `${licenseId} for ${customer}, expired at ${expiresAt}, no seat can be added`,
      };
  }
}

/** Where an operator reads everything Platform printed. */
const PLATFORM_LOG_HINT = `the Platform log has the full output: docker compose -p ${COMPOSE_PROJECT} logs ${PLATFORM_SERVICE}`;

/**
 * platform-license: Platform's license line names a valid license, which passes while it is active, warns while it
 * expires within 30 days or is in its grace period, and fails once the grace period ended; a token Platform refuses
 * fails naming its code, because Platform then adds no seat. A log that no longer reaches Platform's start warns that
 * the check did not run.
 */
export const platformLicenseCheck: Check<PlatformLicenseChecks> = {
  id: "platform-license",
  async run({ license }) {
    const file = license.licenseFile;
    const log = await license.startLog();
    const line = licenseStartLine(log.text);
    if (line === undefined) {
      if (log.text.trim() === "") {
        return {
          passed: true,
          warning:
            `not checked, because Platform's container log no longer holds what Platform printed after its start at ` +
            `${log.startedAt}, as Docker drops the oldest lines of a long log; ${license.platformUrl}/admin/license ` +
            "shows the license state",
          detail: "unknown, Platform's log no longer holds its license line",
        };
      }
      return {
        passed: false,
        cause:
          `Platform printed no license line within ${LICENSE_LOG_WINDOW_MS / 60_000} minutes of its start at ` +
          `${log.startedAt}, so its license state is unknown; ${PLATFORM_LOG_HINT}`,
      };
    }
    if (line.state === "invalid") {
      const meaning = codeMeaning(line.code, license.platformUrl);
      return {
        passed: false,
        cause:
          `the license token in ${file} fails Platform's verification with ${line.code}` +
          `${meaning === undefined ? "" : `, because ${meaning}`}` +
          ", so Platform adds no user, connection or admin until a valid license is installed",
        detail: `invalid, ${line.code}, no seat can be added`,
      };
    }
    return validOutcome(line, file, license.now());
  },
};
