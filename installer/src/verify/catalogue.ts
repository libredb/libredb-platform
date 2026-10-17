// The checks of `verify`. Every module that adds checks registers them in CATALOGUE, which runs
// them in order: a check passes, passes with a warning, fails with a cause, or fails with the message of the error it
// threw, and one failed check makes `verify` exit 4, while a warning leaves the exit code alone.
import { ExitCode } from "../cli/exit-codes";
import { postgresPrivilegesCheck, type PrivilegeCheckContext } from "../sql/matrix";
import { adminMfaCheck, type AdminMfaContext } from "./admin-mfa";
import { edgeTlsCheck, type EdgeTlsContext } from "./edge-tls";
import { HOST_CHECKS, type HostCheckContext } from "./host";
import { OIDC_CHECKS, type OidcCheckContext } from "./oidc-chain";
import { PLATFORM_CHECKS, type PlatformCheckContext } from "./platform";
import { platformLicenseCheck, type PlatformLicenseContext } from "./platform-license";
import { STUDIO_CHECKS, type StudioCheckContext } from "./studio";

/**
 * A warning check, such as admin-mfa, passes with a warning instead of failing. A check may also name what it found in
 * `detail`, such as the license that platform-license read, which the report of `apply` prints.
 */
export type CheckOutcome = ({ passed: true; warning?: string } | { passed: false; cause: string }) & { detail?: string };

export interface Check<C> {
  /** A stable kebab-case id, such as postgres-privileges, which scripts read from the JSON output. */
  readonly id: string;
  run(context: C): Promise<CheckOutcome>;
}

/** What the checks of the catalogue reach the installation through. */
export interface VerifyContext {
  postgres: PrivilegeCheckContext;
  host: HostCheckContext;
  edgeTls: EdgeTlsContext;
  platform: PlatformCheckContext;
  license: PlatformLicenseContext;
  studio: StudioCheckContext;
  oidc: OidcCheckContext;
  keycloak: AdminMfaContext;
}

/** Every check of `verify`, in the order it runs them. */
export const CATALOGUE: readonly Check<VerifyContext>[] = [
  postgresPrivilegesCheck,
  ...HOST_CHECKS,
  edgeTlsCheck,
  ...PLATFORM_CHECKS,
  platformLicenseCheck,
  ...STUDIO_CHECKS,
  ...OIDC_CHECKS,
  adminMfaCheck,
];

export interface CheckResult {
  id: string;
  result: "passed" | "warning" | "failed";
  /** Why the check failed or warned, or null when it passed. */
  cause: string | null;
  /** What the check found, set only by a check that names it, such as platform-license. */
  detail?: string;
}

/** Runs every check in order; a check that throws fails with the error's message as its cause. */
export async function runChecks<C>(checks: readonly Check<C>[], context: C): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      const outcome = await check.run(context);
      const detail = outcome.detail === undefined ? {} : { detail: outcome.detail };
      if (!outcome.passed) results.push({ id: check.id, result: "failed", cause: outcome.cause, ...detail });
      else if (outcome.warning !== undefined) results.push({ id: check.id, result: "warning", cause: outcome.warning, ...detail });
      else results.push({ id: check.id, result: "passed", cause: null, ...detail });
    } catch (error) {
      results.push({ id: check.id, result: "failed", cause: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** 4 when a check failed, 0 otherwise. */
export function verifyExitCode(results: readonly CheckResult[]): ExitCode {
  return results.some((result) => result.result === "failed") ? ExitCode.VerificationFailed : ExitCode.Ok;
}

export const OUTPUT_FORMATS = ["text", "json"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * `json` prints `{"checks": [{"id", "result", "cause"}]}`, with `detail` for a check that names what it found; `text`
 * prints a line per check and a summary.
 */
export function formatResults(results: readonly CheckResult[], format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify({ checks: results }, null, 2)}\n`;
  const lines = results.map((result) =>
    result.result === "passed" ? `passed  ${result.id}` : `${result.result.padEnd(7)} ${result.id}: ${result.cause}`,
  );
  const failed = results.filter((result) => result.result === "failed").length;
  const warned = results.filter((result) => result.result === "warning").length;
  const summary =
    failed === 0
      ? `${results.length} check${results.length === 1 ? "" : "s"} passed`
      : `${failed} of ${results.length} checks failed`;
  lines.push(warned === 0 ? summary : `${summary}, ${warned} with a warning`);
  return `${lines.join("\n")}\n`;
}
