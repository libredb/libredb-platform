// The Docker preflight: evaluates what the step observed on the host against the release
// manifest. Every problem is collected, so one run names everything the operator has to fix.
import { parse } from "yaml";
import { ExitCode } from "../cli/exit-codes";
import type { ReleaseManifest } from "../release/manifest";
import { COMPOSE_PROJECT } from "../render/compose";

/** The Compose service of this installation that publishes the public ports. */
export const EDGE_SERVICE = "edge";

/** The services of this installation that publish a host port: the edge, and Keycloak on its loopback admin port. */
const PUBLISHING_SERVICES: readonly string[] = [EDGE_SERVICE, "keycloak"];

/** What the host answered for one tool: its version, or why it gave none. */
export type ToolObservation = { found: true; version: string } | { found: false; detail: string };

/** The Compose v2 plugin, plus the version of a legacy `docker-compose` v1 binary when the plugin is missing. */
export type ComposeObservation =
  { found: true; version: string } | { found: false; detail: string; legacyVersion?: string };

/** A running container that publishes a port, with its Compose labels, empty when it has none. */
export interface PublishingContainer {
  name: string;
  project: string;
  service: string;
}

/** Who holds one host port the installation publishes. */
export interface PortObservation {
  port: number;
  /** The process name of every listening TCP socket on the port, empty when `ss` could not name it. */
  listeners: string[];
  /** The running containers that publish the port. */
  containers: PublishingContainer[];
}

/** Each host tool the installer runs, and why the host needs it. */
const HOST_TOOLS = {
  ss: "preflight needs it to find what holds each port the installation publishes; it comes with iproute2",
  systemctl: "docker.systemdUnit: true needs it to install and enable libredb.service",
} as const;

export type HostTool = keyof typeof HOST_TOOLS;

/** The host tools the installer runs: ss on every host, and systemctl when docker.systemdUnit is true. */
export function requiredHostTools(systemdUnit: boolean): HostTool[] {
  return systemdUnit ? ["ss", "systemctl"] : ["ss"];
}

export interface DockerHostObservation {
  /** `process.platform`. */
  platform: string;
  uid: number;
  dockerEngine: ToolObservation;
  compose: ComposeObservation;
  /** The tools of requiredHostTools that are not on the PATH; without ss no port is observed. */
  missingTools: HostTool[];
  ports: PortObservation[];
}

/** A host that does not meet the preflight, with one line per problem. */
export class PreflightError extends Error {
  readonly exitCode = ExitCode.PreflightFailed;
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(["preflight failed:", ...problems.map((problem) => `  ${problem}`)].join("\n"));
    this.name = "PreflightError";
    this.problems = problems;
  }
}

// MAJOR.MINOR with an optional PATCH; anything after it, such as -rc.1 or +dfsg1, is a build or distribution suffix.
const VERSION_PREFIX = /^v?(\d+)\.(\d+)(?:\.(\d+))?/;

function versionParts(version: string): [number, number, number] {
  const match = VERSION_PREFIX.exec(version);
  if (match === null) throw new Error(`'${version}' is not a version number`);
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Orders versions by MAJOR.MINOR.PATCH: negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether compareVersions can order the version, such as 26.8.1 or 26.0.15.redhat-00001. */
export function isVersion(version: string): boolean {
  return VERSION_PREFIX.test(version);
}

function checkMinimum(label: string, found: string, minimum: string): string | undefined {
  if (!isVersion(found)) return `${label} reported the version '${found}', which is not a version number`;
  if (compareVersions(found, minimum) < 0) return `${label} ${found} is older than the required ${minimum}`;
  return undefined;
}

/** The Docker Engine releases from `first` through `last`, which a security advisory affects. */
interface RefusedEngineRange {
  first: string;
  last: string;
  advisory: string;
  /** What the advisory lets happen on the host. */
  impact: string;
  /** The first release that fixes it. */
  fixedIn: string;
}

/**
 * The Docker Engine releases that preflight refuses whatever the minimum of the release manifest. From 28.2.0 through
 * 28.3.2, a firewalld reload removes the rules that keep remote hosts away from container addresses, and Docker does
 * not restore them, so a host with a route to a Docker bridge network reaches the published ports, those published to
 * 127.0.0.1 such as keycloak.adminPort included (GHSA-x4rx-4gw3-53p4, CVE-2025-54388); 28.3.3 fixes it. The range is
 * kept here and not in the manifest, because a minimum cannot exclude it and still admit 28.0.x and 28.1.x.
 */
const REFUSED_ENGINE_RANGES: readonly RefusedEngineRange[] = [
  {
    first: "28.2.0",
    last: "28.3.2",
    advisory: "GHSA-x4rx-4gw3-53p4 (CVE-2025-54388)",
    impact:
      "after a firewalld reload, a remote host with a route to a Docker bridge network can reach the published ports, " +
      "even those published to 127.0.0.1",
    fixedIn: "28.3.3",
  },
];

function refusedEngineProblem(version: string): string | undefined {
  const range = REFUSED_ENGINE_RANGES.find(
    ({ first, last }) => compareVersions(version, first) >= 0 && compareVersions(version, last) <= 0,
  );
  if (range === undefined) return undefined;
  const upgrade = `upgrade Docker Engine to ${range.fixedIn} or newer`;
  return `Docker Engine ${version} is affected by ${range.advisory}: ${range.impact}, so ${upgrade}`;
}

function engineProblem(engine: ToolObservation, minimum: string): string | undefined {
  if (!engine.found) return `Docker Engine ${minimum} or newer is required, and none answered: ${engine.detail}`;
  return checkMinimum("Docker Engine", engine.version, minimum) ?? refusedEngineProblem(engine.version);
}

function composeProblem(compose: ComposeObservation, minimum: string): string | undefined {
  if (compose.found) return checkMinimum("the Docker Compose plugin", compose.version, minimum);
  const required = `the Docker Compose v2 plugin (docker compose) ${minimum} or newer is required`;
  if (compose.legacyVersion !== undefined) {
    return `${required}, and only the legacy docker-compose ${compose.legacyVersion} was found`;
  }
  return `${required}, and it is missing: ${compose.detail}`;
}

function isOwnPublisher(container: PublishingContainer): boolean {
  return container.project === COMPOSE_PROJECT && PUBLISHING_SERVICES.includes(container.service);
}

// The holders of a port other than this installation's own edge or Keycloak. Docker publishes a port through
// docker-proxy, so a docker-proxy listener belongs to the containers that publish the port and is named only when none
// does. Without root, ss names no process, and an unnamed listener next to a publishing container is taken as its
// docker-proxy.
function portHolders(observed: PortObservation): string[] {
  const holders = observed.containers.filter((container) => !isOwnPublisher(container)).map((c) => `container ${c.name}`);
  for (const listener of observed.listeners) {
    if ((listener === "docker-proxy" || listener === "") && observed.containers.length > 0) continue;
    holders.push(listener === "" ? "an unknown process" : listener);
  }
  return [...new Set(holders)];
}

/**
 * Throws PreflightError naming every problem of the host: not Linux, not root, Docker Engine or the Compose v2
 * plugin missing or below the manifest minimums, a Docker Engine release of REFUSED_ENGINE_RANGES, a host tool the
 * installer runs missing from the PATH, or a published port held by anything but this installation's edge or Keycloak.
 */
export function checkDockerHost(observed: DockerHostObservation, minimums: ReleaseManifest["minimums"]): void {
  const problems = dockerHostProblems(observed, minimums);
  if (problems.length > 0) throw new PreflightError(problems);
}

/** One line per problem of the host that checkDockerHost refuses, in the order it names them. */
export function dockerHostProblems(observed: DockerHostObservation, minimums: ReleaseManifest["minimums"]): string[] {
  const problems: string[] = [];
  if (observed.platform !== "linux") {
    problems.push(`Docker mode needs a Linux host, and this one is ${observed.platform}`);
  }
  if (observed.uid !== 0) problems.push(`the installer must run as root, and it runs as uid ${observed.uid}`);
  const engine = engineProblem(observed.dockerEngine, minimums.dockerEngine);
  if (engine !== undefined) problems.push(engine);
  const compose = composeProblem(observed.compose, minimums.compose);
  if (compose !== undefined) problems.push(compose);
  for (const tool of observed.missingTools) problems.push(`${tool} is not on the PATH, and ${HOST_TOOLS[tool]}`);
  for (const port of observed.ports) {
    const holders = portHolders(port);
    if (holders.length > 0) {
      problems.push(`port ${port.port}, which the installation publishes, is already in use by ${holders.join(", ")}`);
    }
  }
  return problems;
}

/** The process name of every socket in `ss -Htlnp` output, or an empty name when ss shows no process. */
export function parseSsListeners(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => /users:\(\("([^"]*)"/.exec(line)?.[1] ?? "");
}

/** The host ports a rendered compose.yaml publishes, ascending and once each. */
export function publishedPorts(composeYaml: string): number[] {
  const document = parse(composeYaml) as { services?: Record<string, { ports?: unknown[] }> };
  const ports = new Set<number>();
  for (const [name, service] of Object.entries(document.services ?? {})) {
    for (const entry of service.ports ?? []) {
      const published = Number((entry as { published?: unknown }).published);
      if (typeof entry !== "object" || !Number.isInteger(published)) {
        throw new Error(`service ${name} publishes a port without a numeric published field`);
      }
      ports.add(published);
    }
  }
  return [...ports].sort((a, b) => a - b);
}
