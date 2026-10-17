// Checks release/release.config.json against the newest older release recorded in release/history/:
// the N-1 contract check of src/release/compat.ts. A history file of the current version must equal the config,
// so a recorded release is never changed without a new version.
// It also checks the Studio pin against Platform's tests/fixtures/governance/STUDIO_TAG, the pinned chart and the
// registry, and the Platform digest against the registry. LIBREDB_RELEASE_REGISTRY names a registry mirror, such as
// registry.example.com/libredb, to ask for the Studio and Platform digests instead of the upstream repositories.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkContractCompat, findPreviousRelease } from "../src/release/compat";
import { chartSource } from "../src/release/chart";
import { parseReleaseManifest, type ReleaseManifest } from "../src/release/manifest";
import { platformPinProblems } from "../src/release/platform-pin";
import {
  chartAppVersion,
  type Fetcher,
  manifestUrl,
  registryDigest,
  studioPinProblems,
  studioTagVersion,
} from "../src/release/studio-tag";
import { fetchReleasedChart } from "./embed-release";

const root = join(import.meta.dir, "..");
export const CONFIG_PATH = join(root, "release", "release.config.json");
export const HISTORY_DIR = join(root, "release", "history");
export const STUDIO_TAG_PATH = join(root, "..", "tests", "fixtures", "governance", "STUDIO_TAG");
const HISTORY_FILE = /^(\d+\.\d+\.\d+)\.json$/;

export function readManifest(path: string): ReleaseManifest {
  try {
    return parseReleaseManifest(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

export function recordedVersions(): string[] {
  return readdirSync(HISTORY_DIR)
    .filter((file) => file !== ".gitkeep")
    .map((file) => {
      const match = HISTORY_FILE.exec(file);
      if (match === null) throw new Error(`release/history/${file} is not named <MAJOR.MINOR.PATCH>.json`);
      return match[1] as string;
    });
}

/** Returns every reason the current release config cannot be released after the recorded history. */
export function releaseProblems(current: ReleaseManifest): { previous: string | undefined; problems: string[] } {
  const problems: string[] = [];
  const recordedPath = join(HISTORY_DIR, `${current.version}.json`);
  if (existsSync(recordedPath) && JSON.stringify(readManifest(recordedPath)) !== JSON.stringify(current)) {
    problems.push(
      `release/history/${current.version}.json differs from release/release.config.json, so raise the release version`,
    );
  }
  const previous = findPreviousRelease(current.version, recordedVersions());
  const previousContracts =
    previous === undefined ? null : readManifest(join(HISTORY_DIR, `${previous}.json`)).contracts;
  problems.push(...checkContractCompat(current.contracts, previousContracts));
  return { previous, problems };
}

/** The Chart.yaml of a released Studio chart, downloaded from its repository and checked against the pinned sha256. */
async function releasedChartYaml(chart: ReleaseManifest["studioChart"]): Promise<string> {
  const bytes = await fetchReleasedChart(chart, chart.version);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== chart.sha256) {
    throw new Error(`the Studio chart ${chart.version} has sha256 ${sha256}, but the release pins ${chart.sha256}`);
  }
  const result = Bun.spawnSync(["tar", "-xzO", "-f", "-", `${chart.name}/Chart.yaml`], {
    stdin: bytes,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`the Studio chart ${chart.version} holds no ${chart.name}/Chart.yaml: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

/** What the Studio pin of a release is checked against, besides the registry. */
export interface StudioSources {
  /** The text of Platform's tests/fixtures/governance/STUDIO_TAG. */
  studioTag: string;
  /** The Chart.yaml of a released Studio chart, or undefined for a chart built from a Studio commit. */
  chartYaml: string | undefined;
}

/** Reads Platform's STUDIO_TAG, and the Chart.yaml of a released Studio chart from its repository. */
export async function readStudioSources(chart: ReleaseManifest["studioChart"]): Promise<StudioSources> {
  return {
    studioTag: readFileSync(STUDIO_TAG_PATH, "utf8"),
    chartYaml: chartSource(chart).kind === "git" ? undefined : await releasedChartYaml(chart),
  };
}

/**
 * Returns every reason release:check refuses the release config, in the order it prints them: the history and
 * contract checks of releaseProblems, the Studio pin against STUDIO_TAG, the chart and the registry, and the Platform
 * digest against the registry. `registry` names a registry mirror as LIBREDB_RELEASE_REGISTRY does, and `fetcher`
 * makes every registry request.
 */
export async function releaseCheckProblems(
  current: ReleaseManifest,
  studio: StudioSources,
  registry: string | undefined,
  fetcher: Fetcher,
): Promise<{ previous: string | undefined; problems: string[] }> {
  const { previous, problems } = releaseProblems(current);
  problems.push(
    ...studioPinProblems(current, {
      studioTag: studioTagVersion(studio.studioTag),
      chartAppVersion: chartAppVersion(current.studioChart, studio.chartYaml),
      registryDigest: await registryDigest(manifestUrl(current.images.studio, registry), fetcher),
    }),
  );
  problems.push(...(await platformPinProblems(current, registry, fetcher)));
  return { previous, problems };
}

if (import.meta.main) {
  const current = readManifest(CONFIG_PATH);
  const registry = process.env.LIBREDB_RELEASE_REGISTRY === "" ? undefined : process.env.LIBREDB_RELEASE_REGISTRY;
  const studio = await readStudioSources(current.studioChart);
  const { previous, problems } = await releaseCheckProblems(current, studio, registry, fetch);
  const against = previous === undefined ? "no earlier release recorded" : `previous release ${previous}`;
  if (problems.length > 0) {
    process.stderr.write(`release ${current.version} is not compatible (${against}):\n`);
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `release ${current.version}: contract versions compatible (${against}), ` +
      `platformPublishes [${current.contracts.platformPublishes.join(", ")}], ` +
      `studioSupports [${current.contracts.studioSupports.join(", ")}], ` +
      `Studio ${current.images.studio.version} matches STUDIO_TAG, the chart and the registry digest, ` +
      `and Platform ${current.images.platform.version} matches the registry digest\n`,
  );
}
