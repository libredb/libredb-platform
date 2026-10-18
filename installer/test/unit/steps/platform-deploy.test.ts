import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, exitCodeOf } from "../../../src/cli/commands/docker-session";
import { ExitCode } from "../../../src/cli/exit-codes";
import { loadConfig } from "../../../src/config/load";
import type { DockerInstallation } from "../../../src/config/schema";
import { dockerSecretNames } from "../../../src/docker/secrets";
import { Redactor } from "../../../src/log/redact";
import { computeDesired } from "../../../src/model/desired";
import { FileSecretStore } from "../../../src/secrets/file-store";
import { emptyState } from "../../../src/state/store";
import type { DockerContext } from "../../../src/steps/docker-context";
import { platformDeployStep } from "../../../src/steps/platform-deploy";
import { manifestFixture } from "../release/fixture";

const CONFIG = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");

const root = mkdtempSync(join(tmpdir(), "libredb-platform-deploy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The paths an operator might name: nothing, a symbolic link to a regular file, and a directory.
const missing = join(root, "missing");
const link = join(root, "link");
const directory = join(root, "directory");
// A license file that holds a value of the token's shape that no key signed, as every configuration names one.
const license = join(root, "libredb.license");

// The store as the secrets step leaves it, so platform-deploy reaches every file it reads.
const redactor = new Redactor();
const secrets = new FileSecretStore({ dir: join(root, "secrets"), redactor });

beforeAll(async () => {
  const file = join(root, "file");
  writeFileSync(file, "the-previous-auth-secret\n", { mode: 0o600 });
  symlinkSync(file, link);
  mkdirSync(directory);
  const token = ["ldl1", "0123456789abcdef", Buffer.from('{"v":1}').toString("base64url"), Buffer.alloc(64).toString("base64url")].join(".");
  writeFileSync(license, `${token}\n`, { mode: 0o600 });
  const config = loadConfig({ file: CONFIG, sets: [] });
  await secrets.ensure(dockerSecretNames(config));
  await secrets.ensureSealKey();
});

/**
 * How the run stops when platform-deploy observes the installation of the e2e tests with its license file and `set`
 * applied, in that order.
 */
async function refusal(set: string): Promise<{ code: number; message: string }> {
  const config = loadConfig({ file: CONFIG, sets: [`platform.licenseFile=${license}`, set] }) as DockerInstallation;
  const manifest = manifestFixture();
  const context = { config, manifest, desired: computeDesired(config, manifest), redactor, secrets } as unknown as DockerContext;
  try {
    await platformDeployStep.observe({ context, state: emptyState(), inputHash: "a".repeat(64) });
  } catch (error) {
    return { code: exitCodeOf(error), message: describeError(error) };
  }
  throw new Error(`expected platform-deploy to refuse --set ${set}`);
}

describe("the files that platform.licenseFile and platform.authSecretPreviousFile name", () => {
  test("a symbolic link or a directory there stops platform-deploy while it observes with exit 2 naming the path, as a missing file does", async () => {
    const cases = ["licenseFile", "authSecretPreviousFile"].flatMap((key) =>
      [missing, link, directory].map((path) => ({ key, path })),
    );
    const outcomes = [];
    for (const { key, path } of cases) outcomes.push({ key, path, ...(await refusal(`platform.${key}=${path}`)) });
    expect(outcomes).toEqual(
      cases.map(({ key, path }) => ({
        key,
        path,
        code: ExitCode.InvalidUsage,
        message:
          path === missing
            ? `invalid configuration:\n  platform.${key}: the file ${path} that platform.${key} names does not exist`
            : `invalid configuration:\n  ${path} exists but is not a regular file`,
      })),
    );
  });
});
