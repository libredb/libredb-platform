// The Studio pin of a release against the Studio whose contract Platform vendored: the pinned Studio
// version equals Platform's tests/fixtures/governance/STUDIO_TAG without a leading v, the pinned chart deploys that
// version, and the pinned digest is the one the registry reports for it.
import { parse } from "yaml";
import { chartSource, type StudioChart } from "./chart";
import type { ImageEntry, ReleaseManifest } from "./manifest";

/** What the release is checked against, gathered by the caller. */
export interface StudioPinFacts {
  /** The version Platform's STUDIO_TAG names, as studioTagVersion returns it. */
  studioTag: string;
  /** The app version the pinned Studio chart deploys, as chartAppVersion returns it. */
  chartAppVersion: string;
  /** The digest the registry reports for the pinned Studio version. */
  registryDigest: string;
}

/** Returns every reason the release's Studio pin disagrees with the facts, one sentence each. */
export function studioPinProblems(manifest: ReleaseManifest, facts: StudioPinFacts): string[] {
  const studio = manifest.images.studio;
  const problems: string[] = [];
  if (studio.version !== facts.studioTag) {
    problems.push(
      `the release pins Studio ${studio.version}, but Platform's tests/fixtures/governance/STUDIO_TAG names ${facts.studioTag}, so Platform would run with a Studio whose contract it did not vendor`,
    );
  }
  if (facts.chartAppVersion !== studio.version) {
    problems.push(
      `the pinned Studio chart deploys app version ${facts.chartAppVersion}, but the release pins Studio ${studio.version}`,
    );
  }
  if (facts.registryDigest !== studio.digest) {
    problems.push(
      `the release pins Studio ${studio.version} at ${studio.digest}, but the registry reports ${facts.registryDigest} for that version`,
    );
  }
  return problems;
}

const STUDIO_TAG = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|git:[0-9a-f]{40})\n?$/;

/** The Studio version a STUDIO_TAG file names: its one line without the trailing newline and a leading v. */
export function studioTagVersion(text: string): string {
  const match = STUDIO_TAG.exec(text);
  if (match === null) {
    throw new Error("STUDIO_TAG must hold one Studio release tag such as v0.19.0, or git:<40 hex>, on one line");
  }
  return match[1] as string;
}

/**
 * The app version a Studio chart deploys. A chart built from a Studio commit deploys the image of that same commit,
 * so its app version is git:<sha>; a released chart deploys the appVersion of its Chart.yaml.
 */
export function chartAppVersion(chart: StudioChart, chartYaml: string | undefined): string {
  const source = chartSource(chart);
  if (source.kind === "git") return chart.version;
  if (chartYaml === undefined) throw new Error(`the Studio chart ${chart.version} needs its Chart.yaml`);
  const document: unknown = parse(chartYaml);
  const appVersion =
    typeof document === "object" && document !== null ? (document as { appVersion?: unknown }).appVersion : undefined;
  if (typeof appVersion !== "string" || appVersion === "") {
    throw new Error(`the Chart.yaml of the Studio chart ${chart.version} declares no appVersion`);
  }
  return appVersion;
}

/** The registry tag of an image version: a build of a git commit is tagged git-<sha>, a release by its version. */
export function registryTag(version: string): string {
  return version.replace(/^git:/, "git-");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// The registry API host of Docker Hub, whose image references name docker.io.
const API_HOSTS: Readonly<Record<string, string>> = { "docker.io": "registry-1.docker.io" };

/**
 * The registry API URL of an image version's manifest: in its upstream repository, or in a registry mirror given as
 * `<host>[/<path>]`, where the image keeps its last path segment as the installer's images.registry does.
 * A loopback registry is reached over http, any other over https.
 */
export function manifestUrl(image: ImageEntry, registry: string | undefined): string {
  const name = image.repository.slice(image.repository.lastIndexOf("/") + 1);
  const reference = registry === undefined ? image.repository : `${registry}/${name}`;
  const slash = reference.indexOf("/");
  const host = reference.slice(0, slash);
  const path = reference.slice(slash + 1);
  const scheme = LOOPBACK_HOSTS.has(host.replace(/:\d+$/, "")) ? "http" : "https";
  return `${scheme}://${API_HOSTS[host] ?? host}/v2/${path}/manifests/${registryTag(image.version)}`;
}

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// An index or a single manifest, so the digest is the one a pull by tag resolves to.
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function challengeParameters(header: string): Map<string, string> {
  return new Map([...header.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1] as string, match[2] as string]));
}

/** Gets an anonymous pull token for a Bearer challenge of the registry. */
async function anonymousToken(challenge: string, fetcher: Fetcher): Promise<string> {
  const parameters = challengeParameters(challenge);
  const url = new URL(parameters.get("realm") as string);
  for (const key of ["service", "scope"]) {
    const value = parameters.get(key);
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const response = await fetcher(url.toString(), { method: "GET" });
  const where = `GET ${url.origin}${url.pathname}`;
  if (!response.ok) throw new Error(`${where} answered ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { token?: unknown; access_token?: unknown };
  const token = body.token ?? body.access_token;
  if (typeof token !== "string" || token === "") throw new Error(`${where} answered without a token`);
  return token;
}

/**
 * The digest the registry reports for a manifest URL, read from Docker-Content-Digest of a HEAD request.
 * A Bearer challenge is answered with an anonymous pull token, which public repositories hand out.
 */
export async function registryDigest(url: string, fetcher: Fetcher): Promise<string> {
  const head = (authorization: string | undefined) =>
    fetcher(url, {
      method: "HEAD",
      headers: { accept: MANIFEST_TYPES, ...(authorization === undefined ? {} : { authorization }) },
    });
  let response = await head(undefined);
  const challenge = response.headers.get("www-authenticate");
  if (response.status === 401 && challenge !== null && /^Bearer\s/i.test(challenge)) {
    response = await head(`Bearer ${await anonymousToken(challenge, fetcher)}`);
  }
  if (!response.ok) throw new Error(`HEAD ${url} answered ${response.status} ${response.statusText}`);
  const digest = response.headers.get("docker-content-digest");
  if (digest === null || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`HEAD ${url} answered without a sha256 Docker-Content-Digest`);
  }
  return digest;
}
