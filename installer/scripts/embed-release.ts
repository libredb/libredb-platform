// Fetches the pinned Studio chart, checks its sha256 against the release config and writes the files
// the binary embeds: generated/embedded.json and generated/libredb-studio-<version>.tgz.
//
// A released chart (version 0.1.92) is downloaded from the chart repository named in the config.
// A chart pinned as git:<sha> is built from that commit of a Studio clone named by LIBREDB_STUDIO_REPO:
// the chart directory of the commit plus its dependencies from `helm dependency build`, archived by
// `git archive` with the commit time as every mtime and gzipped by Bun, so the same commit always
// gives the same bytes.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { chartDownloadUrl, chartFileName, chartSource, type StudioChart } from "../src/release/chart";
import { parseReleaseManifest } from "../src/release/manifest";

const root = join(import.meta.dir, "..");
const configPath = join(root, "release", "release.config.json");
const generatedDir = join(root, "generated");
const CHART_PATH = "charts/libredb-studio";

function run(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Buffer {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchReleasedChart(chart: StudioChart, version: string): Promise<Uint8Array> {
  const indexUrl = new URL("index.yaml", chart.repository.endsWith("/") ? chart.repository : `${chart.repository}/`);
  const index = new TextDecoder().decode(await download(indexUrl.toString()));
  return download(chartDownloadUrl(index, chart.repository, chart.name, version));
}

function buildGitChart(commit: string): Uint8Array {
  const repo = process.env.LIBREDB_STUDIO_REPO;
  if (repo === undefined || repo === "") {
    throw new Error(`the Studio chart is pinned to git:${commit}, so set LIBREDB_STUDIO_REPO to a libredb-studio clone that holds it`);
  }
  run(["git", "-C", repo, "cat-file", "-e", `${commit}^{commit}`]);
  const tree = `${commit}:${CHART_PATH}`;
  const commitTime = run(["git", "-C", repo, "show", "-s", "--format=%ct", commit]).toString().trim();
  const work = mkdtempSync(join(tmpdir(), "libredb-embed-"));
  try {
    const chartDir = join(work, "chart");
    mkdirSync(chartDir);
    const tarball = join(work, "chart.tar");
    writeFileSync(tarball, run(["git", "-C", repo, "archive", "--format=tar", tree]));
    run(["tar", "-x", "-f", tarball, "-C", chartDir]);

    // Helm state stays inside the work directory, so the operator's repositories and cache are untouched.
    const helmEnv = {
      HELM_CACHE_HOME: join(work, "helm", "cache"),
      HELM_CONFIG_HOME: join(work, "helm", "config"),
      HELM_DATA_HOME: join(work, "helm", "data"),
    };
    const chartYaml = parse(readFileSync(join(chartDir, "Chart.yaml"), "utf8")) as {
      dependencies?: { repository?: string }[];
    };
    const repositories = [...new Set((chartYaml.dependencies ?? []).map((dependency) => dependency.repository ?? ""))];
    for (const [index, repository] of repositories.entries()) {
      if (repository.startsWith("http://") || repository.startsWith("https://")) {
        run(["helm", "repo", "add", `dependency-${index}`, repository], { env: helmEnv });
      }
    }
    if (repositories.length > 0) run(["helm", "dependency", "build", chartDir], { env: helmEnv });

    const dependencyDir = join(chartDir, "charts");
    const dependencies = repositories.length > 0 ? readdirSync(dependencyDir).sort() : [];
    const archive = run([
      "git",
      "-C",
      repo,
      "archive",
      "--format=tar",
      `--mtime=@${commitTime}`,
      "--prefix=libredb-studio/charts/",
      ...dependencies.map((file) => `--add-file=${join(dependencyDir, file)}`),
      "--prefix=libredb-studio/",
      tree,
    ]);
    return Bun.gzipSync(new Uint8Array(archive), { level: 9 });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function embedRelease(): Promise<{ file: string; sha256: string }> {
  const manifest = parseReleaseManifest(JSON.parse(readFileSync(configPath, "utf8")));
  const chart = manifest.studioChart;
  const source = chartSource(chart);
  const bytes = source.kind === "git" ? buildGitChart(source.commit) : await fetchReleasedChart(chart, source.version);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== chart.sha256) {
    throw new Error(
      `the Studio chart ${chart.version} has sha256 ${sha256}, but release/release.config.json pins ${chart.sha256}`,
    );
  }
  const file = chartFileName(chart);
  rmSync(generatedDir, { recursive: true, force: true });
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, file), bytes);
  writeFileSync(
    join(generatedDir, "embedded.json"),
    `${JSON.stringify({ release: manifest, studioChart: { file, sha256 } }, null, 2)}\n`,
  );
  return { file, sha256 };
}

if (import.meta.main) {
  const { file, sha256 } = await embedRelease();
  process.stdout.write(`embedded generated/${file} (sha256 ${sha256}) and generated/embedded.json\n`);
}
