// `plan`: observes the host and prints what `apply` would change, without changing anything.
import { planGraph } from "../../engine/graph";
import { formatPlan } from "../../docker/report";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { instrumented, parseRunArgs, UsageError, withDockerSession } from "./docker-session";

export const PLAN_USAGE = `Usage: libredb-installer plan -c <libredb.yaml> [--set path=value]... [--only <step,...>]

Observes the host and prints the actions apply would take, or "No changes" when the host matches the configuration.
A step that depends on an earlier one's changes plans against the host as it is now.
`;

export async function runPlan(args: readonly string[], io: Output): Promise<ExitCode> {
  let parsed;
  try {
    parsed = parseRunArgs("plan", args, { only: true });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\n\n${PLAN_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  return withDockerSession("plan", parsed, io, async (session) => {
    const options = session.graph(parsed.only);
    const plans = await planGraph({ ...options, steps: instrumented(options.steps, session.log, undefined) });
    io.stdout(session.redactor.redact(formatPlan(plans)));
    for (const warning of session.warnings) io.stdout(session.redactor.redact(`Warning: ${warning}\n`));
    return ExitCode.Ok;
  });
}
