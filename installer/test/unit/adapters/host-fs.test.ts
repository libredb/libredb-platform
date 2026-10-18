import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOptionalFile, readReferencedFile } from "../../../src/adapters/host-fs";
import { exitCodeOf } from "../../../src/cli/commands/docker-session";
import { ExitCode } from "../../../src/cli/exit-codes";
import { ConfigError } from "../../../src/config/schema";

const root = mkdtempSync(join(tmpdir(), "libredb-host-fs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const file = join(root, "file");
writeFileSync(file, "content\n");
const link = join(root, "link");
symlinkSync(file, link);
const dangling = join(root, "dangling");
symlinkSync(join(root, "nothing"), dangling);
const directory = join(root, "directory");
mkdirSync(directory);

function thrown(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to throw");
}

/** The error of reading `path`, as the exit code and the lines that the command prints for it. */
function refusal(read: (path: string) => unknown, path: string) {
  const error = thrown(() => read(path));
  const lines = error instanceof ConfigError ? error.issues : [(error as Error).message];
  return { path, configuration: error instanceof ConfigError, code: exitCodeOf(error), lines };
}

describe("readReferencedFile, for a file that a *File reference of the configuration names", () => {
  test("returns the content of a regular file, and undefined when nothing is there", () => {
    expect(readReferencedFile(file)).toBe("content\n");
    expect(readReferencedFile(join(root, "missing"))).toBeUndefined();
  });

  test("refuses a symbolic link, a dangling one too, and a directory as an invalid configuration, exit 2, naming the path", () => {
    for (const path of [link, dangling, directory]) {
      expect(refusal(readReferencedFile, path)).toEqual({
        path,
        configuration: true,
        code: ExitCode.InvalidUsage,
        lines: [`${path} exists but is not a regular file`],
      });
    }
  });
});

describe("readOptionalFile, for a file that the installer owns", () => {
  test("refuses a symbolic link or a directory as a runtime failure, exit 1, because the configuration is not at fault", () => {
    for (const path of [link, directory]) {
      expect(refusal(readOptionalFile, path)).toEqual({
        path,
        configuration: false,
        code: ExitCode.RuntimeFailure,
        lines: [`${path} exists but is not a regular file`],
      });
    }
  });
});
