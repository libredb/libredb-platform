import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { loadConfig } from "../../config/load";
import { ConfigError } from "../../config/schema";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";

export const VALIDATE_USAGE = `Usage: libredb-installer validate -c <libredb.yaml> [--set path=value]...

Validates the configuration and prints it normalized, with every default filled in.
`;

export function runValidate(args: readonly string[], io: Output): ExitCode {
  let config: string | undefined;
  let sets: string[];
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        config: { type: "string", short: "c" },
        set: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    });
    config = values.config;
    sets = values.set ?? [];
  } catch (error) {
    io.stderr(`validate: ${(error as Error).message}\n\n${VALIDATE_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  if (config === undefined) {
    io.stderr(`validate: --config (-c) is required\n\n${VALIDATE_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  try {
    io.stdout(stringify(loadConfig({ file: config, sets })));
    return ExitCode.Ok;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr(`invalid configuration:\n${error.issues.map((issue) => `  ${issue}`).join("\n")}\n`);
    return ExitCode.InvalidUsage;
  }
}
