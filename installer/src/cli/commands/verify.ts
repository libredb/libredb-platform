// `verify`: runs every check of the catalogue against the installation, prints each check's id, result and cause as
// text or, with --output json, as JSON, and exits 4 when a check fails, while a warning leaves the exit code at 0.
import { runVerification } from "../../steps/verify";
import { formatResults, OUTPUT_FORMATS, verifyExitCode, type OutputFormat } from "../../verify/catalogue";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { parseRunArgs, UsageError, withDockerSession } from "./docker-session";

export const VERIFY_USAGE = `Usage: libredb-installer verify -c <libredb.yaml> [--set path=value]... [--output text|json]

Runs every check of the installation and prints each check's result, or with --output json every check's id, result
and cause, and the detail of a check that names what it found, such as the license of platform-license.
Exits 4 when a check fails; a warning leaves the exit code at 0.
`;

function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

export async function runVerify(args: readonly string[], io: Output): Promise<ExitCode> {
  let parsed;
  try {
    parsed = parseRunArgs("verify", args, { output: true });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\n\n${VERIFY_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  const output = parsed.output ?? "text";
  if (!isOutputFormat(output)) {
    io.stderr(`verify: --output must be text or json, not ${output}\n\n${VERIFY_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  return withDockerSession("verify", parsed, io, async (session) => {
    const results = await runVerification(session.context);
    io.stdout(session.redactor.redact(formatResults(results, output)));
    return verifyExitCode(results);
  });
}
