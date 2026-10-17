// `apply`: prints the plan, asks for confirmation on a terminal or requires --yes without one, then converges the
// host step by step under the run lock.
import { createInterface } from "node:readline/promises";
import { applyGraph, planGraph } from "../../engine/graph";
import { changeCount, formatPlan } from "../../docker/report";
import { CA_BUNDLE_FILE } from "../../docker/layout";
import { acquireLock } from "../../state/lock";
import { PASSWORD_FILES } from "../../steps/keycloak-configure";
import { formatReport } from "../../steps/report";
import { runVerification } from "../../steps/verify";
import { formatResults, verifyExitCode } from "../../verify/catalogue";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { instrumented, parseRunArgs, UsageError, withDockerSession } from "./docker-session";

export const APPLY_USAGE = `Usage: libredb-installer apply -c <libredb.yaml> [--set path=value]... [--only <step,...>] [--renew-certificates] [--yes]

Prints the plan and applies it after confirmation. Without a terminal, --yes is required.
--renew-certificates re-issues every leaf certificate from the kept internal CA, as the yearly renewal timer does.
A full apply ends with the verify and report steps and exits 4 when a check fails.
--only runs the named steps only, still in graph order, without verify and report.
`;

async function confirm(): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Apply these changes? Type yes to continue: ");
    return answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

export interface ApplyTerminal {
  /** Whether stdin is a terminal the operator can answer a confirmation on. */
  isTTY: boolean;
}

export async function runApply(
  args: readonly string[],
  io: Output,
  terminal: ApplyTerminal = { isTTY: process.stdin.isTTY === true },
): Promise<ExitCode> {
  let parsed;
  try {
    parsed = parseRunArgs("apply", args, { yes: true, only: true, renewCertificates: true });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\n\n${APPLY_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  // Refused before anything runs, so a script that forgot --yes changes nothing on the host.
  if (!parsed.yes && !terminal.isTTY) {
    io.stderr(`apply: stdin is not a terminal, so pass --yes to apply without confirmation\n\n${APPLY_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  return withDockerSession("apply", parsed, io, async (session) => {
    const lock = acquireLock();
    try {
      const options = session.graph(parsed.only);
      const plans = await planGraph({ ...options, steps: instrumented(options.steps, session.log, undefined) });
      io.stdout(session.redactor.redact(formatPlan(plans)));
      if (changeCount(plans) > 0) {
        if (!parsed.yes && !(await confirm())) {
          io.stdout("Apply cancelled; nothing was changed.\n");
          return ExitCode.RuntimeFailure;
        }
        const applied = await applyGraph({ ...options, steps: instrumented(options.steps, session.log, io) });
        const changes = changeCount(applied);
        io.stdout(`Apply complete: ${changes} change${changes === 1 ? "" : "s"}\n`);
      }
      if (parsed.only !== undefined) {
        for (const warning of session.warnings) io.stdout(session.redactor.redact(`Warning: ${warning}\n`));
        return ExitCode.Ok;
      }
      // The verify and report steps change nothing, so they run after every full apply.
      session.log.write("info", "step verify: run every check of the catalogue");
      const results = await runVerification(session.context);
      io.stdout(session.redactor.redact(`\nverify:\n${formatResults(results, "text")}`));
      const report = formatReport({
        desired: session.context.desired,
        config: session.config,
        configFile: parsed.config,
        caBundleFile: CA_BUNDLE_FILE,
        passwordFiles: PASSWORD_FILES,
        results,
        warnings: session.warnings,
      });
      io.stdout(session.redactor.redact(report));
      return verifyExitCode(results);
    } finally {
      lock.release();
    }
  });
}
