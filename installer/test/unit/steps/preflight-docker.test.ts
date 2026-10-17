import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/load";
import type { DockerInstallation } from "../../../src/config/schema";
import { Redactor } from "../../../src/log/redact";
import { computeDesired } from "../../../src/model/desired";
import { PreflightError } from "../../../src/preflight/docker-checks";
import { emptyState } from "../../../src/state/store";
import type { DockerContext } from "../../../src/steps/docker-context";
import { preflightDockerStep } from "../../../src/steps/preflight-docker";
import { manifestFixture } from "../release/fixture";

const CONFIG = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");

/** A Docker context whose Engine and Compose plugin answer, as on a host that has both. */
function context(sets: string[] = []): DockerContext {
  const config = loadConfig({ file: CONFIG, sets }) as DockerInstallation;
  const manifest = manifestFixture();
  return {
    config,
    manifest,
    desired: computeDesired(config, manifest),
    docker: {
      version: async () => ({ client: "27.3.1", server: "27.3.1" }),
      composeVersion: async () => "2.29.7",
    },
    redactor: new Redactor(),
    log: () => {},
    now: () => new Date(),
  } as unknown as DockerContext;
}

/** The problems that the preflight of a host observed through `context` names, with the exit code they carry. */
async function preflightProblems(run: { context: DockerContext }): Promise<{ exitCode: number; problems: readonly string[] }> {
  const step = { ...run, state: emptyState(), inputHash: "a".repeat(64) };
  const observed = await preflightDockerStep.observe(step);
  try {
    preflightDockerStep.plan(observed, step);
  } catch (error) {
    if (error instanceof PreflightError) return { exitCode: error.exitCode, problems: error.problems };
    throw error;
  }
  return { exitCode: 0, problems: [] };
}

// Only Linux asks ss and systemctl; any other host fails on its platform first.
describe.skipIf(process.platform !== "linux")("the preflight of a Linux host without the tools the installer runs", () => {
  let path: string | undefined;
  let empty: string;

  beforeEach(() => {
    // The exec adapter spawns with the PATH of process.env, so a directory without executables hides every tool.
    path = process.env.PATH;
    empty = mkdtempSync(join(tmpdir(), "libredb-no-tools-"));
    process.env.PATH = empty;
  });

  afterEach(() => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    rmSync(empty, { recursive: true, force: true });
  });

  test("a host without ss fails with exit 3 naming ss, instead of the error of running it", async () => {
    const observed = await preflightDockerStep.observe({ context: context(), state: emptyState(), inputHash: "a".repeat(64) });
    expect({ missingTools: observed.missingTools, ports: observed.ports }).toEqual({ missingTools: ["ss"], ports: [] });
    const { exitCode, problems } = await preflightProblems({ context: context() });
    expect(exitCode).toBe(3);
    expect(problems).toContain(
      "ss is not on the PATH, and preflight needs it to find what holds each port the installation publishes; it comes with iproute2",
    );
  });

  test("with docker.systemdUnit true, a host without systemctl fails naming it as well", async () => {
    const { exitCode, problems } = await preflightProblems({ context: context(["docker.systemdUnit=true"]) });
    expect(exitCode).toBe(3);
    expect(problems).toContain(
      "systemctl is not on the PATH, and docker.systemdUnit: true needs it to install and enable libredb.service",
    );
  });
});
