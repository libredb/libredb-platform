// The bootstrap job of the Helm chart charts/libredb-platform: the Kubernetes counterpart of the installer's secrets,
// tls and env steps. It runs as a pre-install and pre-upgrade hook before any app starts, with the installation's
// configuration as the chart rendered it, and writes every Secret and ConfigMap the chart's workloads mount. Every
// value comes from the installer's own modules, so a Helm install gets the same URLs, environments, certificates,
// scripts and keyring as a Docker install of the same configuration.
// A generated secret, a seal key or the internal CA is created once and never replaced; the derived objects are
// written again on every run.
import type { LibreDBInstallation } from "../config/schema";
import { readSecretReference } from "../config/secret-ref";
import { APP_SECRET_NAMES, dockerSecretNames, POSTGRES_SUPERUSER_SECRET, siteSecretReferences } from "../docker/secrets";
import { CLIENT_SECRET_NAMES } from "../keycloak/desired";
import type { Redactor } from "../log/redact";
import { computeDesired, type DesiredInstallation } from "../model/desired";
import { readAuthSecretPrevious, readPlatformLicense, renderPlatformEnv, renderPlatformMigrateEnv } from "../model/platform-env";
import { renderStudioEnv } from "../model/studio-env";
import type { ReleaseManifest } from "../release/manifest";
import { renderCaddyfile } from "../render/caddyfile";
import { renderPgHba } from "../render/compose";
import { generateSecret } from "../secrets/generate";
import { renderKeyring } from "../secrets/keyring";
import { activeSealKey, parseEnvelopeUses, planSealRotation, sealKidsToRetire, type EnvelopeUse } from "../secrets/seal-rotation";
import { generateSealKeyPair } from "../secrets/seal-keys";
import type { SealKeyRecord } from "../secrets/store";
import { renderDbaScript, renderProvisionScript, ROLE_SPECS, roleVerifiers, expectedRoles } from "../sql/provision";
import { checkImmutable, immutableFieldsOf } from "../state/immutable";
import { emptyState, parseState, type InstallerState } from "../state/store";
import { buildCaBundle, caBundleFiles, postgresCaBundleFile, type CaBundleInput } from "../tls/bundle";
import { createCa, type KeyedCertificate } from "../tls/ca";
import { issueLeaf } from "../tls/leaf";
import { desiredTls, planTls, type ObservedTls } from "../tls/plan";
import { ExitCode } from "../cli/exit-codes";
import { compareReleaseVersions } from "../release/compat";
import {
  BOOTSTRAP_CLIENT,
  JOBS_BUNDLE_KEY,
  K8S_NAMES,
  KEYCLOAK_EDGE_PORT,
  STORE_KEYS,
  STUDIO_SECRET_KEYS,
  WORKLOADS,
  type Workload,
} from "./names";

/**
 * A run the configuration or the installation's history refuses, which a retry cannot fix. It carries the installer's
 * exit code, on which the chart's jobs fail at once instead of retrying (podFailurePolicy).
 */
export class RefusedError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "RefusedError";
    this.exitCode = exitCode;
  }
}

/** Secret data by key, as plain text; the adapter encodes and decodes base64. */
export type ObjectData = Record<string, string>;

/** The namespace's Secrets and ConfigMaps, which the adapter reaches through the Kubernetes API. */
export interface KubernetesObjects {
  getSecret(name: string): Promise<ObjectData | undefined>;
  getConfigMap(name: string): Promise<ObjectData | undefined>;
  /** Restarts a Deployment or StatefulSet by a pod template annotation, or reports it absent. */
  restart(workload: Workload, at: Date): Promise<"restarted" | "absent">;
  /** When each pod of a workload was created, or undefined when the workload does not exist. */
  podsCreated(workload: Workload): Promise<Date[] | undefined>;
  /** Creates the Secret or replaces its data. */
  putSecret(name: string, data: ObjectData, type?: "Opaque" | "kubernetes.io/tls"): Promise<void>;
  /** Creates the ConfigMap or replaces its data and its binary data. */
  putConfigMap(name: string, data: ObjectData, binaryData?: Readonly<Record<string, Uint8Array>>): Promise<void>;
}

export interface BootstrapInput {
  config: LibreDBInstallation;
  manifest: ReleaseManifest;
  /** The Secret the Studio chart reads as secrets.existingSecret. */
  studioSecretName: string;
  /** The jobs' gzipped bundle as the hook mounts it, which the keycloak-configure job runs from ConfigMap libredb-jobs. */
  jobsBundle?: Uint8Array;
}

export interface BootstrapIO {
  objects: KubernetesObjects;
  /** The content of a mounted input file, or undefined when it does not exist. */
  readFile(path: string): string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  now(): Date;
  log(line: string): void;
  redactor: Redactor;
}

/** The state Secret's key. */
export const STATE_KEY = "state.json";

/**
 * The state Secret's key of the Platform release the installation last ran, which a downgrade may not go below. The
 * restart job records it once an install or upgrade succeeded, so the rollback that `helm upgrade --atomic` runs after
 * a failed upgrade goes back to a release the installation still counts as its own.
 */
export const RELEASE_KEY = "release";

/**
 * The state Secret's key of the restarts the bootstrap job asks for: the workloads whose inputs it changed and when.
 * The restart job runs after Helm applied the release, so a workload restarts once, with the release's pod template,
 * and a restart a failed run did not finish stays asked for.
 */
export const PENDING_RESTARTS_KEY = "pending-restarts";

export interface PendingRestarts {
  /** When the inputs last changed: a pod created after it already read them. */
  since: string;
  workloads: Workload[];
}

/** The pending restarts in the state Secret, or none. */
export function pendingRestartsOf(data: ObjectData | undefined): PendingRestarts | undefined {
  const text = data?.[PENDING_RESTARTS_KEY];
  return text === undefined || text === "" ? undefined : (JSON.parse(text) as PendingRestarts);
}

/** Adds workloads to the pending restarts, with the time of this change. */
export function addPendingRestarts(previous: PendingRestarts | undefined, workloads: readonly Workload[], at: Date): PendingRestarts {
  const all = new Map<string, Workload>();
  for (const workload of [...(previous?.workloads ?? []), ...workloads]) all.set(`${workload.kind}/${workload.name}`, workload);
  return { since: at.toISOString(), workloads: [...all.values()] };
}

/** Loads the installer state from its Secret, or an empty state for a new installation. */
export async function loadState(objects: KubernetesObjects): Promise<InstallerState> {
  const data = await objects.getSecret(K8S_NAMES.state);
  const text = data?.[STATE_KEY];
  return text === undefined ? emptyState() : parseState(text, `Secret ${K8S_NAMES.state}`);
}

/** Saves the state, keeping the other keys of its Secret, such as the release. */
export async function saveState(objects: KubernetesObjects, state: InstallerState, extra: ObjectData = {}): Promise<void> {
  const current = (await objects.getSecret(K8S_NAMES.state)) ?? {};
  await objects.putSecret(K8S_NAMES.state, { ...current, ...extra, [STATE_KEY]: `${JSON.stringify(state, null, 2)}\n` });
}

/**
 * Refuses to run an older release than the installation last ran: its migrations and its seal and realm logic would
 * meet the newer schema and objects. A downgrade, a `helm rollback` included, restores from a backup instead.
 */
export async function checkRelease(objects: KubernetesObjects, version: string): Promise<void> {
  const recorded = (await objects.getSecret(K8S_NAMES.state))?.[RELEASE_KEY];
  if (recorded !== undefined && compareReleaseVersions(version, recorded) < 0) {
    throw new RefusedError(
      `this chart runs LibreDB ${version}, and the installation already ran ${recorded}: a downgrade is not supported, ` +
        "restore the installation from a backup instead",
      ExitCode.UnsafeChangeRefused,
    );
  }
}

/**
 * Records the immutable fields on the first run and refuses a later run that changes one, such as postgres.mode or
 * keycloak.realm, with the installer's UnsafeChangeError.
 */
export function checkInstallation(state: InstallerState, config: LibreDBInstallation): InstallerState {
  const desired = immutableFieldsOf(config);
  if (state.installation !== undefined) checkImmutable(state.installation, desired);
  return { ...state, installation: desired };
}

/** The names of the generated secrets: the installer's set of the configuration plus the chart's own. */
export function generatedNames(config: LibreDBInstallation): string[] {
  const names = dockerSecretNames(config);
  if (config.keycloak.mode === "managed") names.push(STORE_KEYS.keycloakBootstrapSecret);
  if (config.keycloak.firstAdmin.enabled) names.push(STORE_KEYS.firstAdminPassword);
  if (config.keycloak.userManager.enabled) names.push(STORE_KEYS.userManagerPassword);
  return names;
}

/**
 * Where the chart's seal-envelopes init container writes, for a run whose bridge.sealKeys.retire names a kid, psql's
 * output of envelopeUsesScript: the connections in bridge.connections_v1 whose envelopes those kids sealed.
 */
export const SEAL_ENVELOPES_FILE = "/tmp/seal-envelopes.out";

/**
 * The seal keys after bridge.sealKeys, as the installer's secrets step rotates them: each live kid of retire becomes
 * retired, which keeps it in the store and out of Studio's keyring, and issueNew adds one live key while the active key
 * is the newest live one, so the same values issue no second key. A retirement is refused with exit 6 while an
 * envelope still uses the kid; the chart's restart job deletes a retired kid's canary row once the release applied.
 */
export function rotateSealKeys(
  keys: readonly SealKeyRecord[],
  config: LibreDBInstallation,
  readFile: (path: string) => string | undefined,
): { keys: SealKeyRecord[]; done: string[] } {
  const retiring = sealKidsToRetire(keys, config.bridge.sealKeys);
  let envelopes: EnvelopeUse[] = [];
  if (retiring.length > 0) {
    const uses = readFile(SEAL_ENVELOPES_FILE);
    if (uses === undefined) {
      throw new Error(
        `retiring seal key ${retiring.join(", ")} needs the connections each still seals, which the chart's ` +
          `seal-envelopes init container writes to ${SEAL_ENVELOPES_FILE}, and it wrote none`,
      );
    }
    envelopes = parseEnvelopeUses(uses);
  }
  let rotated = [...keys];
  const done: string[] = [];
  for (const action of planSealRotation(keys, config.bridge.sealKeys, envelopes)) {
    if (action.kind === "retire-seal-key") {
      rotated = rotated.map((key) => (key.kid === action.kid ? { ...key, state: "retired" } : key));
      done.push(`retired seal key ${action.kid}: out of the Studio keyring, kept in the secret store`);
    } else if (action.kind === "issue-seal-key") {
      const issued: SealKeyRecord = { ...generateSealKeyPair(), state: "live" };
      rotated.push(issued);
      done.push(`issued seal key ${issued.kid} into the Studio keyring`);
    }
  }
  return { keys: rotated, done };
}

/** Parses the stored seal keys; a new store gets its first live key. */
export function sealKeysOf(stored: string | undefined): { keys: SealKeyRecord[]; issued: boolean } {
  if (stored === undefined) return { keys: [{ ...generateSealKeyPair(), state: "live" }], issued: true };
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${STORE_KEYS.sealKeys} of Secret ${K8S_NAMES.secretStore} holds no seal key; restore it from a backup`);
  }
  return { keys: parsed as SealKeyRecord[], issued: false };
}

/**
 * The secret store after this run: every missing generated secret drawn once, the site-supplied client secrets of
 * keycloak.external.provisioning manual taken from their references, and the seal keys. Never replaces a stored value
 * that the run generated before.
 */
export function convergeStore(
  config: LibreDBInstallation,
  stored: ObjectData,
  io: Pick<BootstrapIO, "readFile" | "env" | "redactor">,
): { store: ObjectData; changed: string[]; sealKeys: SealKeyRecord[]; rotated: string[] } {
  const store: ObjectData = { ...stored };
  const changed: string[] = [];
  for (const name of generatedNames(config)) {
    if (store[name] !== undefined && store[name] !== "") continue;
    store[name] = generateSecret();
    changed.push(name);
  }
  for (const site of siteSecretReferences(config)) {
    const lookup = readSecretReference(site.reference, { env: io.env, readFile: io.readFile });
    if ("missing" in lookup) throw new Error(`${site.reference.path}: ${lookup.missing}`);
    if (store[site.name] === lookup.value) continue;
    store[site.name] = lookup.value;
    changed.push(site.name);
  }
  const seal = sealKeysOf(store[STORE_KEYS.sealKeys]);
  const rotation = rotateSealKeys(seal.keys, config, io.readFile);
  if (seal.issued || rotation.done.length > 0) {
    store[STORE_KEYS.sealKeys] = JSON.stringify(rotation.keys);
    changed.push(STORE_KEYS.sealKeys);
  }
  for (const [key, value] of Object.entries(store)) {
    if (key !== STORE_KEYS.sealKeys && value !== "") io.redactor.register(value);
  }
  for (const key of rotation.keys) io.redactor.register(key.privateKey);
  return { store, changed, sealKeys: rotation.keys, rotated: rotation.done };
}

const CA_CERT = "ca.crt";
const CA_KEY = "ca.key";
const leafCert = (name: string) => `${name}.crt`;
const leafKey = (name: string) => `${name}.key`;

/** The TLS material in Secret libredb-tls as the installer's tls plan observes it. */
export function observedTls(data: ObjectData, leafNames: readonly string[]): ObservedTls {
  const pair = (cert: string, key: string): Partial<KeyedCertificate> => ({
    ...(data[cert] === undefined ? {} : { certPem: data[cert] }),
    ...(data[key] === undefined ? {} : { keyPem: data[key] }),
  });
  return {
    ca: pair(CA_CERT, CA_KEY),
    leaves: Object.fromEntries(leafNames.map((name) => [name, pair(leafCert(name), leafKey(name))])),
  };
}

/**
 * Creates the internal CA when it is missing and issues every leaf the installer's tls plan issues: missing,
 * unreadable, not covering its hosts, not chaining to the CA, or with fewer than 30 days left. A present CA is never
 * replaced.
 */
export async function convergeTls(
  config: LibreDBInstallation,
  stored: ObjectData,
  now: Date,
  log: (line: string) => void,
): Promise<{ data: ObjectData; changed: boolean }> {
  const desired = desiredTls(config);
  const plan = planTls(observedTls(stored, desired.leaves.map((leaf) => leaf.name)), desired, now);
  const data: ObjectData = { ...stored };
  let changed = false;
  if (plan.ca === "create") {
    const ca = await createCa({ commonName: desired.caCommonName, now });
    data[CA_CERT] = ca.certPem;
    data[CA_KEY] = ca.keyPem;
    changed = true;
    log(`tls: created the internal CA "${desired.caCommonName}"`);
  }
  const ca = { certPem: data[CA_CERT] as string, keyPem: data[CA_KEY] as string };
  for (const leaf of plan.leaves) {
    if (leaf.action === "keep") continue;
    const issued = await issueLeaf(ca, leaf.hosts, now);
    data[leafCert(leaf.name)] = issued.certPem;
    data[leafKey(leaf.name)] = issued.keyPem;
    changed = true;
    log(`tls: issued the ${leaf.name} leaf for ${leaf.hosts.join(", ")} (${leaf.reasons.join("; ")})`);
  }
  return { data, changed };
}

/** The CA bundle of every app container, built as the installer builds it from the configured caBundleFile inputs. */
export function caBundleOf(config: LibreDBInstallation, caPem: string, readFile: (path: string) => string | undefined): string {
  const read = (path: string): CaBundleInput => {
    const pem = readFile(path);
    if (pem === undefined) throw new Error(`the CA bundle file ${path} does not exist`);
    return { source: path, pem };
  };
  const postgresFile = postgresCaBundleFile(config);
  const inputs = caBundleFiles(config)
    .filter((path) => path !== postgresFile)
    .map(read);
  return buildCaBundle(caPem, inputs, postgresFile === undefined ? [] : [read(postgresFile)]);
}

/** The role passwords from the store, by app role. */
function rolePasswords(config: LibreDBInstallation, store: ObjectData): Partial<Record<keyof typeof ROLE_SPECS, string>> {
  const roles = expectedRoles({ managedKeycloak: config.keycloak.mode === "managed", backupRole: true });
  return Object.fromEntries(roles.map((role) => [role, required(store, ROLE_SPECS[role].secret)]));
}

function required(store: ObjectData, name: string): string {
  const value = store[name];
  if (value === undefined || value === "") throw new Error(`Secret ${K8S_NAMES.secretStore} holds no ${name}`);
  return value;
}

/** Whether two objects hold the same keys and values. */
export function sameData(a: ObjectData, b: ObjectData): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Drops the variables an env renderer left unset. */
function defined(env: Readonly<Record<string, string | undefined>>): ObjectData {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * The Caddyfile of a managed Keycloak's edge: the installer's auth site as it renders behind an upstream TLS proxy, here
 * the ingress controller, so only /realms/<realm>/ and /resources/ reach Keycloak, and a non-canonical path does not.
 */
export function keycloakEdgeCaddyfile(config: LibreDBInstallation, manifest: ReleaseManifest): string {
  const behindIngress: LibreDBInstallation = {
    ...config,
    tls: { mode: "external", caBundleFile: "/dev/null", external: { httpPort: KEYCLOAK_EDGE_PORT, trustedProxies: ["private_ranges"] } },
  };
  const desired = computeDesired(behindIngress, manifest);
  return renderCaddyfile({ ...desired, edge: { ...desired.edge, sites: desired.edge.sites.filter((site) => site.endpoint === "auth") } });
}

/** A derived object with the workloads that read it at start, which a change of its content restarts. */
export interface RenderedObjects {
  secrets: { name: string; data: ObjectData; type?: "kubernetes.io/tls"; readers?: Workload[] }[];
  configMaps: { name: string; data: ObjectData; readers?: Workload[] }[];
}

/**
 * The keys of Studio's environment that the Studio chart has no value for, as the installer renders them: the network
 * environment, and the bearer channel of the mobile app with mobile.enabled.
 */
export const STUDIO_EXTRA_ENV_KEYS = ["NO_PROXY", "no_proxy", "HTTPS_PROXY", "NODE_USE_ENV_PROXY", "OIDC_BEARER_AUDIENCE", "OIDC_BEARER_CLIENT_IDS"] as const;

/** Every derived object of the run, from the store, the TLS material and the configuration. */
export function renderObjects(
  input: BootstrapInput,
  desired: DesiredInstallation,
  store: ObjectData,
  sealKeys: readonly SealKeyRecord[],
  tls: ObjectData,
  io: Pick<BootstrapIO, "readFile" | "redactor">,
): RenderedObjects {
  const { config } = input;
  const postgres = { host: desired.postgres.host, port: desired.postgres.port };
  const passwords = rolePasswords(config, store);
  const secrets: RenderedObjects["secrets"] = [];
  const configMaps: RenderedObjects["configMaps"] = [];

  configMaps.push({
    name: K8S_NAMES.caBundle,
    data: { [CA_CERT]: caBundleOf(config, tls[CA_CERT] as string, io.readFile) },
    readers: [WORKLOADS.platform, WORKLOADS.studio, WORKLOADS.keycloak],
  });

  const authSecretPrevious = readAuthSecretPrevious(config.platform, io.readFile);
  if (authSecretPrevious !== undefined) io.redactor.register(authSecretPrevious);
  const platformEnv = renderPlatformEnv(desired, {
    postgres,
    secrets: {
      authSecret: required(store, APP_SECRET_NAMES.platformAuthSecret),
      ...(authSecretPrevious === undefined ? {} : { authSecretPrevious }),
      license: readPlatformLicense(config.platform, io.readFile, io.redactor),
      oidcClientSecret: required(store, CLIENT_SECRET_NAMES.platform),
      databasePassword: passwords.platform as string,
    },
    sealPublicKey: activeSealKey(sealKeys, config.bridge.sealKeys.activeKid).publicKey,
  });
  secrets.push({ name: K8S_NAMES.platformEnv, data: defined(platformEnv), readers: [WORKLOADS.platform] });

  const migrateEnv = renderPlatformMigrateEnv(desired, {
    postgres,
    secrets: { databasePassword: passwords.platform as string, ownerPassword: passwords.owner as string },
  });
  secrets.push({ name: K8S_NAMES.migrateEnv, data: defined(migrateEnv) });

  const studioEnv = renderStudioEnv(desired, {
    postgres,
    secrets: {
      oidcClientSecret: required(store, CLIENT_SECRET_NAMES.studio),
      jwtSecret: required(store, APP_SECRET_NAMES.studioJwtSecret),
      storageEncryptionKey: required(store, APP_SECRET_NAMES.studioStorageEncryptionKey),
      databasePassword: passwords.studio as string,
    },
  });
  secrets.push({
    name: input.studioSecretName,
    data: {
      [STUDIO_SECRET_KEYS.jwtSecret]: studioEnv.JWT_SECRET as string,
      [STUDIO_SECRET_KEYS.oidcClientId]: studioEnv.OIDC_CLIENT_ID as string,
      [STUDIO_SECRET_KEYS.oidcClientSecret]: studioEnv.OIDC_CLIENT_SECRET as string,
      [STUDIO_SECRET_KEYS.storagePostgresUrl]: studioEnv.STORAGE_POSTGRES_URL as string,
      [STUDIO_SECRET_KEYS.governancePostgresUrl]: studioEnv.GOVERNANCE_POSTGRES_URL as string,
      [STUDIO_SECRET_KEYS.governancePrivateKeys]: renderKeyring(sealKeys),
      [STUDIO_SECRET_KEYS.storageEncryptionKey]: studioEnv.STORAGE_ENCRYPTION_KEY as string,
    },
    readers: [WORKLOADS.studio],
  });
  secrets.push({
    name: K8S_NAMES.studioNetworkEnv,
    data: defined(Object.fromEntries(STUDIO_EXTRA_ENV_KEYS.map((key) => [key, studioEnv[key]]))),
    readers: [WORKLOADS.studio],
  });

  const managedKeycloak = config.keycloak.mode === "managed";
  if (config.postgres.mode === "managed") {
    secrets.push({ name: K8S_NAMES.postgresSuperuser, data: { POSTGRES_PASSWORD: required(store, POSTGRES_SUPERUSER_SECRET) } });
    secrets.push({
      name: K8S_NAMES.postgresTls,
      data: { "server.crt": tls[leafCert("postgres")] as string, "server.key": tls[leafKey("postgres")] as string },
      // PostgreSQL reads its leaf at start; a renewed leaf restarts it, which the installer does with a reload.
      readers: [WORKLOADS.postgres],
    });
    configMaps.push({ name: K8S_NAMES.postgresConfig, data: { "pg_hba.conf": renderPgHba() }, readers: [WORKLOADS.postgres] });
    const roles = expectedRoles({ managedKeycloak, backupRole: true });
    secrets.push({
      name: K8S_NAMES.postgresProvision,
      data: {
        "provision.sql": renderProvisionScript({
          verifiers: roleVerifiers(passwords),
          managedKeycloak,
          resetPasswords: roles.filter((role) => role !== "backup"),
        }),
      },
    });
  } else if (config.postgres.external.provisioning === "manual") {
    secrets.push({
      name: K8S_NAMES.postgresDbaScript,
      data: { "provision.sql": renderDbaScript({ passwords, managedKeycloak, server: postgres }) },
    });
  }

  // Only the leaves the configuration still wants: after a switch to tls.mode secrets the store keeps the old ones.
  const wanted = new Set(desiredTls(config).leaves.map((leaf) => leaf.name));
  for (const endpoint of ["platform", "studio", "auth"] as const) {
    const cert = tls[leafCert(endpoint)];
    const key = tls[leafKey(endpoint)];
    if (!wanted.has(endpoint) || cert === undefined || key === undefined) continue;
    secrets.push({
      name: K8S_NAMES.ingressTls(endpoint),
      type: "kubernetes.io/tls",
      data: { "tls.crt": cert, "tls.key": key, [CA_CERT]: tls[CA_CERT] as string },
    });
  }

  if (managedKeycloak) {
    configMaps.push({
      name: K8S_NAMES.keycloakEdge,
      data: { Caddyfile: keycloakEdgeCaddyfile(config, input.manifest) },
      readers: [WORKLOADS.keycloak],
    });
    secrets.push({
      name: K8S_NAMES.keycloakEnv,
      data: {
        KC_DB_PASSWORD: passwords.keycloak as string,
        KC_BOOTSTRAP_ADMIN_CLIENT_ID: BOOTSTRAP_CLIENT,
        KC_BOOTSTRAP_ADMIN_CLIENT_SECRET: required(store, STORE_KEYS.keycloakBootstrapSecret),
      },
      readers: [WORKLOADS.keycloak],
    });
  }
  const keycloakConfig: ObjectData = {
    [CLIENT_SECRET_NAMES.studio]: required(store, CLIENT_SECRET_NAMES.studio),
    [CLIENT_SECRET_NAMES.platform]: required(store, CLIENT_SECRET_NAMES.platform),
  };
  if (managedKeycloak) keycloakConfig[STORE_KEYS.keycloakBootstrapSecret] = required(store, STORE_KEYS.keycloakBootstrapSecret);
  for (const key of [STORE_KEYS.firstAdminPassword, STORE_KEYS.userManagerPassword]) {
    if (store[key] !== undefined) keycloakConfig[key] = store[key];
  }
  secrets.push({ name: K8S_NAMES.keycloakConfig, data: keycloakConfig });

  return { secrets, configMaps };
}

/** Runs the bootstrap job. */
export async function runBootstrap(input: BootstrapInput, io: BootstrapIO): Promise<void> {
  const { config, manifest } = input;
  if (config.postgres.mode === "external" && config.postgres.external.provisioning !== "manual") {
    throw new RefusedError(
      "the Helm chart supports an external PostgreSQL server only with provisioning manual: a DBA runs the script in " +
        `Secret ${K8S_NAMES.postgresDbaScript}, so no admin credential of the server enters the cluster`,
      ExitCode.InvalidUsage,
    );
  }
  await checkRelease(io.objects, manifest.version);
  const state = checkInstallation(await loadState(io.objects), config);

  const converged = convergeStore(config, (await io.objects.getSecret(K8S_NAMES.secretStore)) ?? {}, io);
  for (const line of converged.rotated) io.log(`seal keys: ${line}`);
  if (converged.changed.length > 0) {
    await io.objects.putSecret(K8S_NAMES.secretStore, converged.store);
    io.log(`secrets: stored ${converged.changed.join(", ")} in Secret ${K8S_NAMES.secretStore}`);
  }

  const tls = await convergeTls(config, (await io.objects.getSecret(K8S_NAMES.tls)) ?? {}, io.now(), io.log);
  if (tls.changed) await io.objects.putSecret(K8S_NAMES.tls, tls.data);

  const desired = computeDesired(config, manifest);
  const rendered = renderObjects(input, desired, converged.store, converged.sealKeys, tls.data, io);
  if (input.jobsBundle !== undefined) {
    await io.objects.putConfigMap(K8S_NAMES.jobsBundle, {}, { [JOBS_BUNDLE_KEY]: input.jobsBundle });
    io.log(`wrote ConfigMap ${K8S_NAMES.jobsBundle}`);
  }
  // A workload reads its Secrets and ConfigMaps when it starts, so one whose input changed must restart. The restarts
  // are recorded before any object is written, so a run that fails halfway still leaves them asked for, and the
  // restart job carries them out after Helm applied the release.
  const restart = new Map<string, Workload>();
  const changed = (before: ObjectData | undefined, after: ObjectData, readers: Workload[] | undefined) => {
    if (readers === undefined || (before !== undefined && sameData(before, after))) return;
    for (const reader of readers) restart.set(`${reader.kind}/${reader.name}`, reader);
  };
  for (const configMap of rendered.configMaps) changed(await io.objects.getConfigMap(configMap.name), configMap.data, configMap.readers);
  for (const secret of rendered.secrets) changed(await io.objects.getSecret(secret.name), secret.data, secret.readers);
  const stateData = (await io.objects.getSecret(K8S_NAMES.state)) ?? {};
  const pending = pendingRestartsOf(stateData);
  if (restart.size > 0) {
    const asked = addPendingRestarts(pending, [...restart.values()], io.now());
    await io.objects.putSecret(K8S_NAMES.state, { ...stateData, [PENDING_RESTARTS_KEY]: JSON.stringify(asked) });
    io.log(`asked to restart ${asked.workloads.map((workload) => `${workload.kind}/${workload.name}`).join(", ")} once the release is applied`);
  }
  for (const configMap of rendered.configMaps) {
    await io.objects.putConfigMap(configMap.name, configMap.data);
    io.log(`wrote ConfigMap ${configMap.name}`);
  }
  for (const secret of rendered.secrets) {
    await io.objects.putSecret(secret.name, secret.data, secret.type);
    io.log(`wrote Secret ${secret.name}`);
  }
  await saveState(io.objects, state);
  io.log("bootstrap done");
}

/**
 * The restart job, a post-install and post-upgrade hook: restarts each workload the bootstrap job asked for, unless all
 * its pods were created after the change, as a rollout of the release's own pod template or a first install makes
 * them; a workload that does not exist is dropped. The request is cleared only once every restart was done, and the
 * release is then recorded as the one the installation runs.
 */
export async function runRestarts(
  objects: KubernetesObjects,
  version: string,
  now: () => Date,
  log: (line: string) => void,
): Promise<void> {
  const stateData = (await objects.getSecret(K8S_NAMES.state)) ?? {};
  const pending = pendingRestartsOf(stateData);
  if (pending === undefined) {
    log("no restart asked for");
    await objects.putSecret(K8S_NAMES.state, { ...stateData, [RELEASE_KEY]: version });
    log(`the installation runs LibreDB ${version}`);
    return;
  }
  const since = new Date(pending.since).getTime();
  for (const workload of pending.workloads) {
    const name = `${workload.kind}/${workload.name}`;
    const created = await objects.podsCreated(workload);
    if (created === undefined) {
      log(`${name} does not exist`);
    } else if (created.length > 0 && created.every((at) => at.getTime() >= since)) {
      log(`${name} started after its inputs changed`);
    } else {
      await objects.restart(workload, now());
      log(`restarted ${name}: an input it reads at start changed`);
    }
  }
  const { [PENDING_RESTARTS_KEY]: _done, ...rest } = (await objects.getSecret(K8S_NAMES.state)) ?? {};
  await objects.putSecret(K8S_NAMES.state, { ...rest, [RELEASE_KEY]: version });
  log(`the installation runs LibreDB ${version}`);
}
