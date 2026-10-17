// Step 1 of the Docker graph: observes the host through the exec and Docker adapters, and an external
// Keycloak through its Admin API (src/steps/preflight-external.ts), and fails with exit 3 when either does not meet
// the release manifest, when the host lacks a tool the installer runs, such as ss, when a provided certificate cannot
// be used, or when a public host behind an external TLS proxy does not resolve or present a valid chain from inside
// the edge network. It never changes anything, so its plan is always empty.
import { readFileSync } from "node:fs";
import { ExecError, exec, type OutputLine } from "../adapters/exec";
import type { Docker } from "../adapters/docker";
import { DockerProbeRunner } from "../adapters/in-network-probe";
import type { DockerInstallation } from "../config/schema";
import { composeNetworks } from "../docker/project";
import type { Step } from "../engine/step";
import type { Redactor } from "../log/redact";
import type { DesiredInstallation } from "../model/desired";
import {
  dockerHostProblems,
  parseSsListeners,
  PreflightError,
  publishedPorts,
  requiredHostTools,
  type ComposeObservation,
  type DockerHostObservation,
  type HostTool,
  type PortObservation,
  type PublishingContainer,
  type ToolObservation,
} from "../preflight/docker-checks";
import { EXTERNAL_TLS_SCRIPT, externalTlsProblems, parseExternalTlsProbe } from "../preflight/external-tls";
import type { ExternalKeycloakObservation } from "../preflight/external-keycloak";
import type { ReleaseManifest } from "../release/manifest";
import { loadProvidedTls, providedEndpoints } from "../tls/provided";
import { renderedCompose } from "./deploy";
import type { DockerContext } from "./docker-context";
import { checkExternalKeycloakFindings, observeExternalKeycloak } from "./preflight-external";

export interface DockerPreflightContext {
  config: DockerInstallation;
  /** The installer's clock, which the certificate checks use. */
  now: () => Date;
  manifest: ReleaseManifest;
  desired: DesiredInstallation;
  docker: Docker;
  redactor: Redactor;
  log: (line: OutputLine) => void;
}

const QUICK_MS = 60_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "ENOENT";
}

async function observeEngine(context: DockerPreflightContext): Promise<ToolObservation> {
  try {
    return { found: true, version: (await context.docker.version()).server };
  } catch (error) {
    if (error instanceof ExecError || isMissingExecutable(error)) return { found: false, detail: messageOf(error) };
    throw error;
  }
}

// The version of a legacy docker-compose v1 binary, or undefined when none is installed.
async function legacyComposeVersion(context: DockerPreflightContext): Promise<string | undefined> {
  try {
    const result = await exec(["docker-compose", "version", "--short"], {
      redactor: context.redactor,
      log: context.log,
      timeoutMs: QUICK_MS,
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch (error) {
    if (isMissingExecutable(error)) return undefined;
    throw error;
  }
}

async function observeCompose(context: DockerPreflightContext): Promise<ComposeObservation> {
  try {
    return { found: true, version: await context.docker.composeVersion() };
  } catch (error) {
    if (!(error instanceof ExecError) && !isMissingExecutable(error)) throw error;
    const legacyVersion = await legacyComposeVersion(context);
    return legacyVersion === undefined
      ? { found: false, detail: messageOf(error) }
      : { found: false, detail: messageOf(error), legacyVersion };
  }
}

/** The host tools the installer runs that are not on the PATH the exec adapter spawns them with. */
function missingHostTools(context: DockerPreflightContext): HostTool[] {
  return requiredHostTools(context.desired.systemdUnit).filter((tool) => Bun.which(tool, { PATH: process.env.PATH }) === null);
}

async function observePort(
  context: DockerPreflightContext,
  port: number,
  engineFound: boolean,
): Promise<PortObservation> {
  const options = { redactor: context.redactor, log: context.log, timeoutMs: QUICK_MS, check: true };
  const sockets = await exec(["ss", "-Htlnp", `sport = :${port}`], options);
  const containers: PublishingContainer[] = [];
  if (engineFound) {
    const format = '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}';
    const listed = await exec(["docker", "ps", "--filter", `publish=${port}`, "--format", format], options);
    for (const line of listed.stdout.split("\n").filter((row) => row.trim() !== "")) {
      const [name = "", project = "", service = ""] = line.split("\t");
      containers.push({ name, project, service });
    }
  }
  return { port, listeners: parseSsListeners(sockets.stdout), containers };
}

/** The Docker network that the probe of the external TLS preflight runs on. */
const DEFAULT_BRIDGE = "bridge";

/**
 * Probes every public host from inside the edge network, or from Docker's default bridge before the base step has
 * created that network: without the edge's aliases both resolve names through the same upstream DNS. A CA bundle
 * that cannot be read is reported before any container runs, because Docker would create a missing mount source.
 */
async function observeExternalTls(context: DockerPreflightContext): Promise<ExternalTlsObservation> {
  const caBundleFile = context.config.tls.caBundleFile as string;
  let caBundlePem: string;
  try {
    caBundlePem = readFileSync(caBundleFile, "utf8");
  } catch (error) {
    return { problems: [`tls.caBundleFile: cannot read ${caBundleFile}: ${messageOf(error)}`] };
  }
  const edge = composeNetworks(renderedCompose(context.desired)).find((network) => network.key === "edge");
  if (edge === undefined) throw new Error("the rendered installation has no edge network");
  const network = (await context.docker.networkInspect(edge.name)) === undefined ? DEFAULT_BRIDGE : edge.name;
  const hosts = context.desired.edge.sites.map((site) => site.host);
  const runner = new DockerProbeRunner({
    image: context.desired.images.platform,
    network,
    caBundleFile,
    redactor: context.redactor,
    log: context.log,
    namePrefix: "libredb-preflight",
  });
  const result = await runner.run({ script: EXTERNAL_TLS_SCRIPT, env: { LIBREDB_HOSTS: JSON.stringify(hosts) } });
  const probes = parseExternalTlsProbe(result, hosts);
  return { problems: externalTlsProblems(probes, caBundlePem, caBundleFile, context.now()) };
}

interface ExternalTlsObservation {
  problems: string[];
}

/** What preflight observes: the host, and the external Keycloak when the configuration reuses one. */
export interface PreflightObservation extends DockerHostObservation {
  /** Set in tls.mode external while the Docker Engine answers. */
  externalTls: ExternalTlsObservation | undefined;
  externalKeycloak: ExternalKeycloakObservation | undefined;
}

/** The problems of the provided chains and keys, which the tls step refuses the same way. */
function providedProblems(context: DockerPreflightContext): string[] {
  const endpoints = providedEndpoints(context.config, context.desired.edge.sites);
  if (endpoints.length === 0) return [];
  try {
    loadProvidedTls({
      endpoints,
      caBundleFile: context.config.tls.caBundleFile as string,
      readFile: (path) => readFileSync(path, "utf8"),
      now: context.now(),
    });
    return [];
  } catch (error) {
    if (error instanceof PreflightError) return [...error.problems];
    throw error;
  }
}

export const preflightDockerStep: Step<DockerContext, PreflightObservation> = {
  name: "preflight",
  inputs: (context) => ({
    minimums: context.manifest.minimums,
    ports: publishedPorts(renderedCompose(context.desired)),
  }),
  async observe({ context, state }) {
    const platform = process.platform;
    const dockerEngine = await observeEngine(context);
    const compose = await observeCompose(context);
    // Without Linux there is no ss to ask, and the platform problem already fails the preflight; without ss the missing
    // tool does.
    const missingTools = platform === "linux" ? missingHostTools(context) : [];
    const ports =
      platform === "linux" && !missingTools.includes("ss")
        ? await Promise.all(
            publishedPorts(renderedCompose(context.desired)).map((port) =>
              observePort(context, port, dockerEngine.found),
            ),
          )
        : [];
    const externalTls =
      context.config.tls.mode === "external" && dockerEngine.found ? await observeExternalTls(context) : undefined;
    return {
      platform,
      uid: process.getuid?.() ?? -1,
      dockerEngine,
      compose,
      missingTools,
      ports,
      externalTls,
      externalKeycloak: await observeExternalKeycloak(context, state),
    };
  },
  plan(observed, { context }) {
    const problems = [
      ...dockerHostProblems(observed, context.manifest.minimums),
      ...providedProblems(context),
      ...(observed.externalTls?.problems ?? []),
    ];
    if (problems.length > 0) throw new PreflightError(problems);
    checkExternalKeycloakFindings(observed.externalKeycloak, context);
    return [];
  },
  apply() {
    throw new Error("the preflight step plans no action, so there is nothing to apply");
  },
};
