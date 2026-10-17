import { parseArgs } from "node:util";
import { loadConfig } from "../../config/load";
import { ConfigError } from "../../config/schema";
import { effectiveImages } from "../../release/images";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { embeddedRelease } from "../release";

export const IMAGES_USAGE = `Usage: libredb-installer images list [-c <libredb.yaml>] [--set path=value]...

Prints the image references of this release, one per line, each pinned by its sha256 digest.
With a configuration that sets images.registry, every reference points at that registry mirror.
`;

export function runImages(args: readonly string[], io: Output): ExitCode {
  const [subcommand, ...rest] = args;
  if (subcommand !== "list") {
    io.stderr(`${subcommand === undefined ? "" : `images: unknown subcommand '${subcommand}'\n\n`}${IMAGES_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  let config: string | undefined;
  let sets: string[];
  try {
    const { values } = parseArgs({
      args: rest,
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
    io.stderr(`images list: ${(error as Error).message}\n\n${IMAGES_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  if (config === undefined && sets.length > 0) {
    io.stderr(`images list: --set needs a configuration, so pass -c as well\n\n${IMAGES_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  let registry: string | undefined;
  if (config !== undefined) {
    try {
      registry = loadConfig({ file: config, sets }).images?.registry;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      io.stderr(`invalid configuration:\n${error.issues.map((issue) => `  ${issue}`).join("\n")}\n`);
      return ExitCode.InvalidUsage;
    }
  }
  io.stdout(effectiveImages(embeddedRelease(), registry).map((image) => `${image.reference}\n`).join(""));
  return ExitCode.Ok;
}
