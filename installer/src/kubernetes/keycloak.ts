// The keycloak-configure job of the Helm chart: the Kubernetes counterpart of the installer's keycloak-configure step,
// which it runs unchanged. The realm, its clients, client scope, roles and accounts come from desiredKeycloak, the
// actions from planKeycloak, and every Admin REST request from the same request builder, so a Helm install converges
// the same objects as a Docker install. The installer state, which records the accounts it created, lives in a Secret.
//
// A managed Keycloak is reached in-cluster with the bootstrap admin client of realm master, whose secret only the
// generated Secrets hold. Unlike the Docker install, the chart keeps that client: Keycloak's environment is part of a
// Helm-managed Deployment, and Keycloak would recreate the client from it on the next start.
import type { AdminCredentials } from "../adapters/keycloak-admin";
import { KeycloakAdmin } from "../adapters/keycloak-admin";
import type { LibreDBInstallation } from "../config/schema";
import { desiredKeycloak, managedRealm, CLIENT_SECRET_NAMES, type Account } from "../keycloak/desired";
import { lookupAdminCredentials } from "../keycloak/external";
import { planKeycloak, type KeycloakAction } from "../keycloak/planner";
import { MANAGED_ATTRIBUTE } from "../keycloak/representations";
import type { Redactor } from "../log/redact";
import { computeDesired } from "../model/desired";
import type { ReleaseManifest } from "../release/manifest";
import type { InstallerState } from "../state/store";
import { ExitCode } from "../cli/exit-codes";
import { loadState, RefusedError, saveState, type KubernetesObjects } from "./bootstrap";
import { BOOTSTRAP_CLIENT, K8S_NAMES, KEYCLOAK_SERVICE, STORE_KEYS } from "./names";

/** The in-cluster Admin API of a managed Keycloak: its Service on the HTTP port. */
export const MANAGED_KEYCLOAK_URL = `http://${KEYCLOAK_SERVICE}:8080`;

/** Where the chart mounts Secret libredb-keycloak-config into the job. */
export const KEYCLOAK_CONFIG_DIR = "/etc/libredb/keycloak-config";

/** The installer step's functions, injected so the pure module does not import the Docker step. */
export interface ConvergeFunctions {
  observe(target: ConvergeTarget, state: InstallerState): Promise<Parameters<typeof planKeycloak>[1]>;
  apply(actions: readonly KeycloakAction[], target: ConvergeTarget, state: InstallerState): Promise<void>;
}

/** The ConfigureTarget of the installer's keycloak-configure step. */
export interface ConvergeTarget {
  baseUrl: string;
  realm: string;
  credentials: AdminCredentials;
  desired: ReturnType<typeof desiredKeycloak>;
  passwordFiles: Readonly<Record<Account, string>>;
  owner: { uid: number; gid: number };
  redactor: Redactor;
  log: (line: string) => void;
  fetch?: typeof fetch;
}

export interface KeycloakJobIO {
  objects: KubernetesObjects;
  readFile(path: string): string | undefined;
  /** Writes a 0600 file of the job's own user, for the step's temporary password files. */
  writeFile(path: string, content: string): void;
  env: Readonly<Record<string, string | undefined>>;
  /** A directory the job may write to. */
  tmpDir: string;
  owner: { uid: number; gid: number };
  log(line: string): void;
  redactor: Redactor;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function configValue(io: Pick<KeycloakJobIO, "readFile" | "redactor">, key: string): string {
  const value = io.readFile(`${KEYCLOAK_CONFIG_DIR}/${key}`);
  if (value === undefined || value === "") throw new Error(`Secret ${K8S_NAMES.keycloakConfig} holds no ${key}`);
  io.redactor.register(value);
  return value;
}

/** Where the job reaches the Admin API and as whom. */
export function adminTarget(
  config: LibreDBInstallation,
  io: Pick<KeycloakJobIO, "readFile" | "env" | "redactor">,
): { baseUrl: string; credentials: AdminCredentials } {
  if (config.keycloak.mode === "managed") {
    return {
      baseUrl: MANAGED_KEYCLOAK_URL,
      credentials: { realm: "master", clientId: BOOTSTRAP_CLIENT, clientSecret: configValue(io, STORE_KEYS.keycloakBootstrapSecret) },
    };
  }
  const { external } = config.keycloak;
  if (external.provisioning === "manual") {
    throw new RefusedError(
      "keycloak.external.provisioning is manual: the site configures the realm, and the chart runs no keycloak job",
      ExitCode.InvalidUsage,
    );
  }
  const lookup = lookupAdminCredentials(external, { env: io.env, readFile: io.readFile });
  if ("missing" in lookup) throw new RefusedError(lookup.missing, ExitCode.InvalidUsage);
  io.redactor.register(lookup.secret);
  return { baseUrl: external.adminUrl ?? external.baseUrl, credentials: lookup.credentials };
}

/** Creates the realm of a managed Keycloak with the settings the converge keeps, as the installer's handover does. */
export async function ensureManagedRealm(admin: Pick<KeycloakAdmin, "find" | "write">, realm: string): Promise<"created" | "exists"> {
  const found = await admin.find<{ attributes?: Record<string, unknown> }>(`/admin/realms/${encodeURIComponent(realm)}`);
  if (found === undefined) {
    await admin.write("POST", "/admin/realms", managedRealm(realm), [201]);
    return "created";
  }
  if (found.attributes?.[MANAGED_ATTRIBUTE] !== "true") {
    throw new RefusedError(
      `realm ${realm} exists without the attribute ${MANAGED_ATTRIBUTE}=true that the installer gives the realm it ` +
        "creates, so the chart does not take it over; install with keycloak.mode external instead",
      ExitCode.UnsafeChangeRefused,
    );
  }
  return "exists";
}

/** How long the job waits for Keycloak to answer before it fails, and how often it tries. */
export const KEYCLOAK_WAIT = { timeoutMs: 10 * 60_000, intervalMs: 3_000 } as const;

/**
 * Waits until Keycloak answers HTTP at `baseUrl`, whatever the status, so a job that starts beside a Keycloak that is
 * still starting waits instead of failing; it fails with the last connection error once `timeoutMs` passed.
 */
export async function waitForKeycloak(
  baseUrl: string,
  options: {
    fetch: typeof fetch;
    log: (line: string) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<void> {
  const { timeoutMs = KEYCLOAK_WAIT.timeoutMs, intervalMs = KEYCLOAK_WAIT.intervalMs } = options;
  const deadline = options.now() + timeoutMs;
  let waiting = false;
  for (;;) {
    try {
      const response = await options.fetch(`${baseUrl}/realms/master`, { signal: AbortSignal.timeout(intervalMs * 3) });
      await response.body?.cancel();
      if (waiting) options.log(`keycloak: ${baseUrl} answers`);
      return;
    } catch (error) {
      if (options.now() >= deadline) {
        throw new Error(`Keycloak at ${baseUrl} did not answer within ${timeoutMs / 1000} s: ${(error as Error).message}`);
      }
      if (!waiting) options.log(`keycloak: waiting for ${baseUrl} to answer`);
      waiting = true;
      await options.sleep(intervalMs);
    }
  }
}

/** Runs the keycloak-configure job. */
export async function runKeycloakJob(
  config: LibreDBInstallation,
  manifest: ReleaseManifest,
  io: KeycloakJobIO,
  converge: ConvergeFunctions,
): Promise<void> {
  const desired = computeDesired(config, manifest);
  const { baseUrl, credentials } = adminTarget(config, io);
  await waitForKeycloak(baseUrl, {
    fetch: io.fetch ?? fetch,
    log: io.log,
    sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: io.now ?? Date.now,
  });
  if (config.keycloak.mode === "managed") {
    const admin = new KeycloakAdmin({ baseUrl, credentials, log: io.log, ...(io.fetch === undefined ? {} : { fetch: io.fetch }) });
    const realm = await ensureManagedRealm(admin, desired.realm);
    io.log(`keycloak: realm ${desired.realm} ${realm}`);
  }
  const passwordFiles: Record<Account, string> = {
    "first-admin": `${io.tmpDir}/first-admin.txt`,
    "user-manager": `${io.tmpDir}/user-manager.txt`,
  };
  // The temporary passwords were generated by the bootstrap job; the step reads a stored password file before it
  // generates one, so the accounts get exactly these.
  const accounts: [Account, boolean, string][] = [
    ["first-admin", config.keycloak.firstAdmin.enabled, STORE_KEYS.firstAdminPassword],
    ["user-manager", config.keycloak.userManager.enabled, STORE_KEYS.userManagerPassword],
  ];
  for (const [account, enabled, key] of accounts) {
    if (enabled) io.writeFile(passwordFiles[account], `${configValue(io, key)}\n`);
  }
  const target: ConvergeTarget = {
    baseUrl,
    realm: desired.realm,
    credentials,
    desired: desiredKeycloak({
      installation: desired,
      keycloak: config.keycloak,
      clientSecrets: {
        studio: configValue(io, CLIENT_SECRET_NAMES.studio),
        platform: configValue(io, CLIENT_SECRET_NAMES.platform),
      },
      passwordLocations: {
        firstAdmin: `Secret ${K8S_NAMES.keycloakConfig} key ${STORE_KEYS.firstAdminPassword}`,
        userManager: `Secret ${K8S_NAMES.keycloakConfig} key ${STORE_KEYS.userManagerPassword}`,
      },
    }),
    passwordFiles,
    owner: io.owner,
    redactor: io.redactor,
    log: io.log,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  };
  const state = await loadState(io.objects);
  const observed = await converge.observe(target, state);
  const actions = planKeycloak(target.desired, observed);
  for (const action of actions) io.log(`keycloak: ${action.summary}`);
  await converge.apply(actions, target, state);
  await saveState(io.objects, state);
  io.log(actions.length === 0 ? "keycloak: realm already converged" : `keycloak: applied ${actions.length} actions`);
}
