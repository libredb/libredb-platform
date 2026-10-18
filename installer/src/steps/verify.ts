// The `verify` step, step 14 of the graph: wires the checks of the catalogue to a Docker installation and runs them.
// The `verify` command runs it alone, and a full `apply` runs it after the last deploy step.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { exec } from "../adapters/exec";
import { readReferencedFile } from "../adapters/host-fs";
import { DockerProbeRunner } from "../adapters/in-network-probe";
import { KeycloakAdmin, requestToken, type ClientCredentials } from "../adapters/keycloak-admin";
import { presentedChain } from "../adapters/tls-probe";
import { CA_BUNDLE_FILE } from "../docker/layout";
import { composeNetworks } from "../docker/project";
import { platformSealKey, POSTGRES_SUPERUSER_SECRET } from "../docker/secrets";
import { APP_CLIENT_IDS, CLIENT_SECRET_NAMES } from "../keycloak/desired";
import { keycloakAdminHosts, noProxyHosts } from "../model/no-proxy";
import { readPlatformLicense } from "../model/platform-env";
import { parseComposeEnvFile, PLATFORM_ENV_FILE, PLATFORM_SERVICE, STUDIO_ENV_FILE } from "../render/compose";
import { ROLE_SPECS } from "../sql/provision";
import { POSTGRES_NAMES } from "../state/immutable";
import type { AdminMfaContext } from "../verify/admin-mfa";
import { CATALOGUE, runChecks, type CheckResult, type VerifyContext } from "../verify/catalogue";
import { startLogWindow, type PlatformStartLog } from "../verify/platform-license";
import { HEARTBEAT_WAIT_MS } from "../verify/studio";
import { COMPOSE_TARGET, renderedCompose } from "./deploy";
import type { DockerContext } from "./docker-context";
import { externalKeycloakFetch } from "./keycloak-configure";
import { INSTALLER_ENV_FILE, readInstallerCredentials } from "./keycloak-handover";
import { platformLogin, postgresServer, secretValue } from "./platform-deploy";
import { managedAdminLogin, postgresRunner } from "./postgres-provision";

/** How long seal-canary-published waits for a Platform that has just started to publish its canary. */
const CANARY_WAIT_MS = 30_000;
/** How long studio-canary waits for every instance to report the canary ok after a reload. */
const STUDIO_CANARY_WAIT_MS = 60_000;
const QUICK_MS = 60_000;

/** The services of the compose file that run, leaving out those of a profile such as the migrate job. */
export function runningServices(composeYaml: string): string[] {
  const document = parse(composeYaml) as { services?: Record<string, { profiles?: unknown }> };
  return Object.entries(document.services ?? {})
    .filter(([, service]) => service.profiles === undefined)
    .map(([name]) => name);
}

/** BRIDGE_SEAL_PUBLIC_KEY of the env file Platform runs with. */
function installedSealPublicKey(): string {
  const key = parseComposeEnvFile(readFileSync(PLATFORM_ENV_FILE, "utf8")).get("BRIDGE_SEAL_PUBLIC_KEY");
  if (key === undefined || key === "") throw new Error(`${PLATFORM_ENV_FILE} sets no BRIDGE_SEAL_PUBLIC_KEY`);
  return key;
}

interface VerifyClient {
  credentials: ClientCredentials;
  fetch?: typeof fetch;
}

/**
 * The client verify reads Keycloak with: libredb-installer of a managed Keycloak, whose service account holds
 * realm-admin, or libredb-platform of the reused realm of an external one, whose secret the store holds and whose
 * service account holds view-users and view-clients, so verify needs no customer admin credential. Undefined when
 * installer.env of a managed Keycloak does not exist.
 */
async function verifyClient(context: DockerContext): Promise<VerifyClient | undefined> {
  const { config, desired } = context;
  if (config.keycloak.mode === "external") {
    const clientSecret = await secretValue(context, CLIENT_SECRET_NAMES.platform);
    return {
      credentials: { realm: desired.realm, clientId: APP_CLIENT_IDS.platform, clientSecret },
      fetch: externalKeycloakFetch(config.keycloak.external),
    };
  }
  const credentials = readInstallerCredentials({
    installerEnvFile: INSTALLER_ENV_FILE,
    realm: desired.realm,
    redactor: context.redactor,
  });
  return credentials === undefined ? undefined : { credentials };
}

async function clockClient(context: DockerContext): Promise<VerifyClient> {
  const client = await verifyClient(context);
  if (client === undefined) throw new Error(`${INSTALLER_ENV_FILE} does not exist, so no Keycloak token can be asked`);
  return client;
}

/** The Admin API reader of admin-mfa, through the Admin API URL as the installer reaches it. */
async function mfaAdmin(context: DockerContext): Promise<AdminMfaContext["admin"]> {
  const client = await verifyClient(context);
  if (client === undefined) return { unavailable: `${INSTALLER_ENV_FILE} does not exist` };
  return new KeycloakAdmin({
    baseUrl: context.desired.keycloak.adminUrl,
    credentials: client.credentials,
    log: context.info,
    ...(client.fetch === undefined ? {} : { fetch: client.fetch }),
  });
}

/**
 * Keycloak's clock: the `iat` of a token from the Admin API URL, because Keycloak 26 sends no Date header. The token
 * is registered with the redactor and never printed.
 */
async function keycloakTime(context: DockerContext): Promise<number> {
  const { desired } = context;
  const { credentials, fetch } = await clockClient(context);
  const answer = await requestToken({ baseUrl: desired.keycloak.adminUrl, log: context.info, fetch }, credentials);
  if (!("token" in answer)) throw new Error(`Keycloak refused the ${credentials.clientId} token with ${answer.status}`);
  context.redactor.register(answer.token);
  const payload = JSON.parse(Buffer.from(answer.token.split(".")[1] ?? "", "base64url").toString("utf8")) as { iat?: unknown };
  if (typeof payload.iat !== "number") throw new Error("the Keycloak token holds no iat");
  return payload.iat * 1000;
}

/**
 * What Platform's container printed in the first minutes of its current run, which hold its license line. Only that
 * window is read, so a long log never reaches the run log. Docker's json-file driver drops the oldest file of a long
 * log, and the few lines of the window, which one file holds, then go with it.
 */
async function platformStartLog(context: DockerContext): Promise<PlatformStartLog> {
  // Platform never logs the token; registering it with the redactor keeps it out of the run log all the same.
  readPlatformLicense(context.config.platform, readReferencedFile, context.redactor);
  const container = (await context.docker.ps(COMPOSE_TARGET)).find((candidate) => candidate.service === PLATFORM_SERVICE);
  if (container === undefined) throw new Error(`the project has no ${PLATFORM_SERVICE} container`);
  const options = { redactor: context.redactor, log: context.log, timeoutMs: QUICK_MS, check: true };
  const inspected = await exec(["docker", "inspect", "--format", "{{.State.StartedAt}}", container.id], options);
  const startedAt = inspected.stdout.trim();
  const { since, until } = startLogWindow(startedAt);
  const logs = await exec(["docker", "logs", "--since", since, "--until", until, container.id], options);
  return { startedAt, text: `${logs.stdout}\n${logs.stderr}` };
}

/**
 * What the checks of the catalogue reach a Docker installation through. The PostgreSQL facts, the clock and the
 * bridge privileges are read as the superuser of a managed server, and as libredb_platform on an external one, whose
 * admin credential the installer never keeps; every catalog row they read is visible to an app role.
 */
export async function dockerVerifyContext(context: DockerContext): Promise<VerifyContext> {
  const { desired } = context;
  const runner = postgresRunner(context);
  const server = postgresServer(context);
  const admin = desired.postgres.managed
    ? managedAdminLogin(await secretValue(context, POSTGRES_SUPERUSER_SECRET))
    : platformLogin(server, await secretValue(context, ROLE_SPECS.platform.secret));
  const compose = renderedCompose(desired);
  const edge = composeNetworks(compose).find((network) => network.key === "edge");
  const platform = desired.edge.sites.find((site) => site.endpoint === "platform");
  const studio = desired.edge.sites.find((site) => site.endpoint === "studio");
  if (edge === undefined || platform === undefined || studio === undefined) {
    throw new Error("the rendered installation has no edge network, no platform site or no studio site");
  }
  const probeRunner = (image: string) =>
    new DockerProbeRunner({ image, network: edge.name, caBundleFile: CA_BUNDLE_FILE, redactor: context.redactor, log: context.log });
  // Platform's own image and network, so the HTTP checks resolve and trust what Platform does.
  const platformProbe = probeRunner(desired.images.platform);
  const studioLogin = {
    ...server,
    database: POSTGRES_NAMES.database,
    user: POSTGRES_NAMES.roles.studio,
    password: await secretValue(context, ROLE_SPECS.studio.secret),
  };
  const sleep = (ms: number) => Bun.sleep(ms);
  const { contracts } = context.manifest;
  return {
    postgres: {
      runner,
      admin,
      observer: desired.postgres.managed ? "admin" : "app-role",
      managedKeycloak: context.config.keycloak.mode === "managed",
    },
    host: {
      now: () => Date.now(),
      sql: runner,
      admin,
      keycloakClock: {
        what: `the Keycloak clock (iat of a token from ${desired.keycloak.adminUrl})`,
        read: () => keycloakTime(context),
      },
      readFile: (path) => readFileSync(path, "utf8"),
      appEnvFiles: [PLATFORM_ENV_FILE, STUDIO_ENV_FILE],
      noProxyHosts: noProxyHosts(desired.hosts, server.host, keycloakAdminHosts(desired)),
      services: runningServices(compose),
      containers: () => context.docker.ps(COMPOSE_TARGET),
    },
    edgeTls: {
      // The edge publishes every site on its port of the host, which the installer reaches on loopback. Behind an
      // upstream proxy, which terminates TLS on the public port of each host, the installer reaches each host by name.
      endpoints: desired.edge.sites.map((site) => ({ host: site.host, port: site.port })),
      readCaBundle: () => readFileSync(CA_BUNDLE_FILE, "utf8"),
      presentedChain: (endpoint) =>
        presentedChain({
          address: desired.edge.scheme === "https" ? "127.0.0.1" : endpoint.host,
          port: endpoint.port,
          servername: endpoint.host,
        }),
      now: () => Date.now(),
    },
    platform: {
      probe: platformProbe,
      sql: runner,
      admin: { ...admin, database: POSTGRES_NAMES.database },
      studio: studioLogin,
      platformUrl: desired.urls.platform,
      readyUrl: `http://${platform.upstream}/api/health/ready`,
      issuer: desired.issuer,
      platformEnvFile: PLATFORM_ENV_FILE,
      platformPublishes: contracts.platformPublishes,
      sealPublicKey: platformSealKey(await context.secrets.sealKeys(), context.config.bridge.sealKeys.activeKid).publicKey,
      canaryWaitMs: CANARY_WAIT_MS,
      sleep,
    },
    license: {
      licenseFile: context.config.platform.licenseFile,
      platformUrl: desired.urls.platform,
      startLog: () => platformStartLog(context),
      now: () => Date.now(),
    },
    studio: {
      probe: platformProbe,
      readyUrl: `http://${studio.upstream}/api/ready`,
      sql: runner,
      login: studioLogin,
      platformPublishes: contracts.platformPublishes,
      studioSupports: contracts.studioSupports,
      reportedVersion: context.manifest.studio.reportedVersion,
      platformSealPublicKey: installedSealPublicKey,
      heartbeatWaitMs: HEARTBEAT_WAIT_MS,
      canaryWaitMs: STUDIO_CANARY_WAIT_MS,
      sleep,
    },
    oidc: {
      probe: platformProbe,
      studioUrl: desired.urls.studio,
      issuer: desired.issuer,
      studioRedirectUri: desired.clients.studio.redirectUri,
      discovery: [
        { app: "Platform", probe: platformProbe, envFile: PLATFORM_ENV_FILE },
        { app: "Studio", probe: probeRunner(desired.images.studio), envFile: STUDIO_ENV_FILE },
      ],
    },
    keycloak: { realm: desired.realm, admin: await mfaAdmin(context) },
  };
}

/** Runs every check of the catalogue against the installation. */
export async function runVerification(context: DockerContext): Promise<CheckResult[]> {
  return runChecks(CATALOGUE, await dockerVerifyContext(context));
}
