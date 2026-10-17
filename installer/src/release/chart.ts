// Where the pinned Studio chart comes from: a chart repository release, or a build of a Studio git commit.
import { parse } from "yaml";
import type { ReleaseManifest } from "./manifest";

export type StudioChart = ReleaseManifest["studioChart"];

export type ChartSource = { kind: "repository"; version: string } | { kind: "git"; commit: string };

/** A chart version of the form git:<40 hex> is a build of that Studio commit, any other is a released chart. */
export function chartSource(chart: StudioChart): ChartSource {
  if (chart.version.startsWith("git:")) return { kind: "git", commit: chart.version.slice("git:".length) };
  return { kind: "repository", version: chart.version };
}

/** The file name the chart is embedded under: libredb-studio-<version>.tgz, with git:<sha> written as git-<sha>. */
export function chartFileName(chart: StudioChart): string {
  return `${chart.name}-${chart.version.replace(":", "-")}.tgz`;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Finds the download URL of one chart version in a Helm repository index.yaml.
 * A relative URL in the index resolves against the repository URL. Throws when the version is not published.
 */
export function chartDownloadUrl(indexYaml: string, repositoryUrl: string, name: string, version: string): string {
  const index: unknown = parse(indexYaml);
  const entries = isMapping(index) && isMapping(index.entries) ? index.entries[name] : undefined;
  if (!Array.isArray(entries)) throw new Error(`the chart repository ${repositoryUrl} has no chart named ${name}`);
  const entry: unknown = entries.find((candidate) => isMapping(candidate) && candidate.version === version);
  if (!isMapping(entry)) throw new Error(`the chart repository ${repositoryUrl} has no ${name} version ${version}`);
  const [url] = Array.isArray(entry.urls) ? entry.urls : [];
  if (typeof url !== "string") throw new Error(`the chart repository ${repositoryUrl} lists ${name} ${version} without a URL`);
  const base = repositoryUrl.endsWith("/") ? repositoryUrl : `${repositoryUrl}/`;
  return new URL(url, base).toString();
}
