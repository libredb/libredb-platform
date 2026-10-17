// Step 10 of the graph: the Admin REST converge of the Keycloak objects that Platform and Studio rely on
// (src/keycloak/desired.ts), never a realm import. It reads the realm through the Admin API: a managed Keycloak's as
// libredb-installer on the loopback port, whose brute force detection, password policy and events it converges too,
// and the reused realm of an external Keycloak, whose settings it never changes, with the customer's admin
// credential, which it reads from its *Env or *File reference on each run and never stores. It plans with the pure
// planner of src/keycloak and sends one request per action, so a client secret regenerated in the console converges
// back to the stored one and a second run sends GET requests only. The installation's accounts get their temporary
// passwords in root-only files, written before the account exists, and the state records each account it created. With
// keycloak.external.provisioning manual the site configured the realm from the installer's export, and the step only
// checks it from outside with the two client secrets, without any Keycloak admin credential.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFile, observePath, readOptionalFile } from "../adapters/host-fs";
import { randomBytes } from "node:crypto";
import { KeycloakAdmin, requestToken, trustingFetch, type AdminCredentials } from "../adapters/keycloak-admin";
import type { ExternalKeycloak } from "../config/schema";
import { SECRETS_DIR } from "../docker/layout";
import { hashInputs } from "../engine/graph";
import type { Action, Step } from "../engine/step";
import {
  APP_CLIENT_IDS,
  CLIENT_SECRET_NAMES,
  desiredKeycloak,
  REALM_MANAGEMENT,
  ROLE_CLIENT_ID,
  type Account,
  type DesiredKeycloak,
} from "../keycloak/desired";
import { adminAccess, lookupAdminCredentials } from "../keycloak/external";
import { planKeycloak, type KeycloakAction } from "../keycloak/planner";
import type {
  ClientRepresentation,
  ClientRoleNames,
  ClientScopeRepresentation,
  ObservedClient,
  ObservedKeycloak,
  ObservedUser,
  RealmRepresentation,
  RoleRef,
  RoleRepresentation,
} from "../keycloak/representations";
import { adminRequest, createdObject, idFromLocation, type CreatedObject, type RequestContext } from "../keycloak/requests";
import type { Redactor } from "../log/redact";
import {
  checkManualKeycloak,
  manualExpectations,
  type HttpAnswer,
  type ManualKeycloakExpectations,
  type ManualKeycloakObservation,
} from "../preflight/keycloak-manual";
import { generateSecret } from "../secrets/generate";
import type { InstallerState } from "../state/store";
import { certificateToPem, parseCertificates } from "../tls/inspect";
import { projectContainers } from "./deploy";
import { recordedInputHash, recordOwnership, type DockerContext } from "./docker-context";
import { INSTALLER_ENV_FILE, readInstallerCredentials } from "./keycloak-handover";

/** The 0600 root-owned files with the temporary passwords of the installation's accounts. */
export const PASSWORD_FILES: Readonly<Record<Account, string>> = {
  "first-admin": join(SECRETS_DIR, "first-admin.txt"),
  "user-manager": join(SECRETS_DIR, "user-manager.txt"),
};

/** The kind of the state's ownership record of a Keycloak user this installation created. */
export const KEYCLOAK_USER_KIND = "keycloak-user";

const STEP = "keycloak-configure";

/** The realm to converge and how the installer reaches it. */
export interface ConfigureTarget {
  /**
   * Where the installer reaches the Admin API: the loopback URL of a managed Keycloak's port 8080, such as
   * http://127.0.0.1:18080, or the admin URL of an external Keycloak.
   */
  baseUrl: string;
  realm: string;
  /** The libredb-installer client of a managed Keycloak's realm, or the customer's admin credential. */
  credentials: AdminCredentials;
  desired: DesiredKeycloak;
  /** Where each account's temporary password is kept. */
  passwordFiles: Readonly<Record<Account, string>>;
  /** The owner of the password files: root in an install. */
  owner: { uid: number; gid: number };
  /** Receives every client secret and temporary password the step reads or generates. */
  redactor: Redactor;
  /** Receives one line per Keycloak request. */
  log: (line: string) => void;
  fetch?: typeof fetch;
}

const segment = encodeURIComponent;

const realmPath = (realm: string) => `/admin/realms/${segment(realm)}`;

function adminOf(target: ConfigureTarget): KeycloakAdmin {
  return new KeycloakAdmin({ baseUrl: target.baseUrl, credentials: target.credentials, log: target.log, fetch: target.fetch });
}

interface RoleMappings {
  clientMappings?: Record<string, { mappings?: { name: string }[] }>;
}

/** The client role names of a role-mapping or scope-mapping answer, by the clientId of the client that holds them. */
function clientRoleNames(mappings: RoleMappings): ClientRoleNames {
  return Object.fromEntries(
    Object.entries(mappings.clientMappings ?? {}).map(([clientId, entry]) => [
      clientId,
      (entry.mappings ?? []).map((role) => role.name),
    ]),
  );
}

/** The client of a realm with this clientId, with its protocol mappers, or undefined when the realm has none. */
export async function findClient(
  admin: KeycloakAdmin,
  realm: string,
  clientId: string,
): Promise<(ClientRepresentation & { id: string }) | undefined> {
  const found = await admin.get<(ClientRepresentation & { id: string })[]>(
    `${realmPath(realm)}/clients?clientId=${segment(clientId)}&first=0&max=2`,
  );
  if (found.length > 1) throw new Error(`realm ${realm} holds more than one client ${clientId}`);
  return found[0];
}

async function observeClient(target: ConfigureTarget, admin: KeycloakAdmin, clientId: string): Promise<ObservedClient | undefined> {
  const representation = await findClient(admin, target.realm, clientId);
  if (representation === undefined) return undefined;
  if (typeof representation.secret === "string" && representation.secret !== "") target.redactor.register(representation.secret);
  const path = `${realmPath(target.realm)}/clients/${segment(representation.id)}`;
  const roles = await admin.get<RoleRepresentation[]>(`${path}/roles?briefRepresentation=false`);
  const scopeMappings = clientRoleNames(await admin.get<RoleMappings>(`${path}/scope-mappings`));
  if (representation.serviceAccountsEnabled !== true) return { representation, roles, scopeMappings };
  const account = await admin.get<{ id: string }>(`${path}/service-account-user`);
  const clientRoles = clientRoleNames(
    await admin.get<RoleMappings>(`${realmPath(target.realm)}/users/${segment(account.id)}/role-mappings`),
  );
  return { representation, roles, scopeMappings, serviceAccount: { id: account.id, clientRoles } };
}

async function observeUser(target: ConfigureTarget, admin: KeycloakAdmin, username: string): Promise<ObservedUser | undefined> {
  const found = await admin.get<{ id: string; username: string }[]>(
    `${realmPath(target.realm)}/users?username=${segment(username)}&exact=true`,
  );
  const user = found.find((candidate) => candidate.username === username);
  if (user === undefined) return undefined;
  const mappings = await admin.get<RoleMappings>(`${realmPath(target.realm)}/users/${segment(user.id)}/role-mappings`);
  return { id: user.id, username: user.username, clientRoles: clientRoleNames(mappings) };
}

/** The usernames the state records as created by this step. */
export function createdUsers(state: InstallerState): string[] {
  return state.ownership.filter((record) => record.kind === KEYCLOAK_USER_KIND && record.step === STEP).map((record) => record.name);
}

/** Reads what the converge plans against, with GET requests only; the realm itself only when the installer owns its settings. */
export async function observeKeycloak(target: ConfigureTarget, state: InstallerState): Promise<ObservedKeycloak> {
  const admin = adminOf(target);
  const base = realmPath(target.realm);
  const realmRepresentation =
    target.desired.realmSettings === undefined ? undefined : await admin.get<RealmRepresentation>(base);
  const defaults = await admin.get<{ name: string; protocol?: string }[]>(`${base}/default-default-client-scopes`);
  const scopes = await admin.get<(ClientScopeRepresentation & { id: string })[]>(`${base}/client-scopes`);
  const clientScopes = [];
  for (const representation of scopes) {
    const managed = representation.name === target.desired.clientScope.representation.name;
    const scopeMappings = managed
      ? clientRoleNames(await admin.get<RoleMappings>(`${base}/client-scopes/${segment(representation.id)}/scope-mappings`))
      : {};
    clientScopes.push({ representation, scopeMappings });
  }
  const clients: ObservedClient[] = [];
  const clientIds = [target.desired.roleClient, ...target.desired.appClients].map((client) => client.representation.clientId);
  for (const clientId of [...clientIds, REALM_MANAGEMENT]) {
    const client = await observeClient(target, admin, clientId);
    if (client !== undefined) clients.push(client);
  }
  const users: ObservedUser[] = [];
  for (const { username } of target.desired.users) {
    const user = await observeUser(target, admin, username);
    if (user !== undefined) users.push(user);
  }
  return {
    realm: target.realm,
    ...(realmRepresentation === undefined ? {} : { realmRepresentation }),
    defaultClientScopes: defaults.filter((scope) => scope.protocol === "openid-connect").map((scope) => scope.name),
    clientScopes,
    clients,
    users,
    createdUsers: createdUsers(state),
  };
}

/** The ids of the realm's objects, looked up once each and learned from the Location of every create. */
class RealmIds implements RequestContext {
  readonly #admin: KeycloakAdmin;
  readonly #realm: string;
  readonly #ids = new Map<string, string>();
  readonly #roles = new Map<string, RoleRef>();
  readonly #passwords = new Map<string, string>();

  constructor(admin: KeycloakAdmin, realm: string) {
    this.#admin = admin;
    this.#realm = realm;
  }

  async #cached(key: string, lookup: () => Promise<string>): Promise<string> {
    const known = this.#ids.get(key);
    if (known !== undefined) return known;
    const id = await lookup();
    this.#ids.set(key, id);
    return id;
  }

  clientUuid(clientId: string): Promise<string> {
    return this.#cached(`client ${clientId}`, async () => {
      const client = await findClient(this.#admin, this.#realm, clientId);
      if (client === undefined) throw new Error(`realm ${this.#realm} has no client ${clientId}`);
      return client.id;
    });
  }

  clientScopeId(name: string): Promise<string> {
    return this.#cached(`client-scope ${name}`, async () => {
      const scopes = await this.#admin.get<{ id: string; name: string }[]>(`${realmPath(this.#realm)}/client-scopes`);
      const scope = scopes.find((candidate) => candidate.name === name);
      if (scope === undefined) throw new Error(`realm ${this.#realm} has no client scope ${name}`);
      return scope.id;
    });
  }

  async role(clientId: string, name: string): Promise<RoleRef> {
    const key = `${clientId}:${name}`;
    const known = this.#roles.get(key);
    if (known !== undefined) return known;
    const path = `${realmPath(this.#realm)}/clients/${segment(await this.clientUuid(clientId))}/roles/${segment(name)}`;
    const role = await this.#admin.get<{ id: string; name: string }>(path);
    const ref = { id: role.id, name: role.name };
    this.#roles.set(key, ref);
    return ref;
  }

  serviceAccountUserId(clientId: string): Promise<string> {
    return this.#cached(`service-account ${clientId}`, async () => {
      const path = `${realmPath(this.#realm)}/clients/${segment(await this.clientUuid(clientId))}/service-account-user`;
      return (await this.#admin.get<{ id: string }>(path)).id;
    });
  }

  userId(username: string): Promise<string> {
    return this.#cached(`user ${username}`, async () => {
      const found = await this.#admin.get<{ id: string; username: string }[]>(
        `${realmPath(this.#realm)}/users?username=${segment(username)}&exact=true`,
      );
      const user = found.find((candidate) => candidate.username === username);
      if (user === undefined) throw new Error(`realm ${this.#realm} has no user ${username}`);
      return user.id;
    });
  }

  async temporaryPassword(username: string): Promise<string> {
    const password = this.#passwords.get(username);
    if (password === undefined) throw new Error(`no temporary password was stored for user ${username}`);
    return password;
  }

  setTemporaryPassword(username: string, password: string): void {
    this.#passwords.set(username, password);
  }

  record(object: CreatedObject, id: string): void {
    this.#ids.set(`${object.kind} ${object.key}`, id);
  }
}

/**
 * The temporary password of an account about to be created: the one an earlier run stored before it stopped, or a
 * new one, written to its 0600 file before Keycloak receives it.
 */
function temporaryPassword(file: string, target: ConfigureTarget): string {
  const observed = observePath(file);
  if (observed !== undefined) {
    if (observed.kind !== "file") throw new Error(`${file} exists but is not a regular file`);
    const stored = observed.content.trim();
    if (stored === "") throw new Error(`${file} is empty; remove it, and the installer writes a new temporary password`);
    target.redactor.register(stored);
    const { uid, gid } = target.owner;
    if (observed.mode !== 0o600 || observed.uid !== uid || observed.gid !== gid) {
      applyFile({ path: file, content: observed.content, mode: 0o600, uid, gid });
    }
    return stored;
  }
  const password = generateSecret();
  target.redactor.register(password);
  applyFile({ path: file, content: `${password}\n`, mode: 0o600, ...target.owner });
  return password;
}

/**
 * Sends one Admin REST request per action, in plan order. An account the step creates is recorded in the state as
 * soon as Keycloak created it, so a later failure in the same run never leaves it unrecorded.
 */
export async function applyKeycloak(
  actions: readonly KeycloakAction[],
  target: ConfigureTarget,
  state: InstallerState,
): Promise<void> {
  const admin = adminOf(target);
  const ids = new RealmIds(admin, target.realm);
  for (const action of actions) {
    if (action.kind === "create-user") {
      const user = target.desired.users.find((candidate) => candidate.username === action.username);
      if (user === undefined) throw new Error(`the plan creates user ${action.username}, which is not an account of the installation`);
      ids.setTemporaryPassword(action.username, temporaryPassword(target.passwordFiles[user.account], target));
    }
    const request = await adminRequest(target.realm, action, ids);
    const response = await admin.write(request.method, request.path, request.body, request.expected);
    const created = createdObject(action);
    if (created !== undefined) ids.record(created, idFromLocation(response.location, `${created.kind} ${created.key}`));
    if (action.kind === "create-user") recordOwnership(state, { kind: KEYCLOAK_USER_KIND, name: action.username, step: STEP });
  }
}

type ConfigureObservation =
  | { pending: string }
  | { skipped: string }
  | { desired: DesiredKeycloak; observed: ObservedKeycloak }
  | { manual: ManualKeycloakObservation; expected: ManualKeycloakExpectations };

type ConfigureAction = KeycloakAction | (Action & { kind: "pending"; reason: string });

const summaryOf = (context: DockerContext) =>
  `configure the clients, the client scope and the accounts in realm ${context.desired.realm}`;

/** The step's inputs: the realm, where its issuer is, the OIDC URIs and the accounts. They hold no secret. */
function configureInputs(context: DockerContext) {
  const { keycloak } = context.config;
  // Named only for a realm the site configures, so the inputs of every other install keep the hash they had.
  const manual = keycloak.mode === "external" && keycloak.external.provisioning === "manual";
  return {
    ...(manual ? { provisioning: "manual" } : {}),
    realm: context.desired.realm,
    issuer: context.desired.issuer,
    clients: context.desired.clients,
    firstAdmin: context.config.keycloak.firstAdmin,
    userManager: context.config.keycloak.userManager,
  };
}

/** Whether the step last converged the realm with the inputs of this run. */
export function keycloakInputsUnchanged(context: DockerContext, state: InstallerState): boolean {
  return recordedInputHash(state, STEP) === hashInputs(configureInputs(context));
}

/**
 * The customer's admin credential for `purpose`, read from its reference and registered with the redactor, or the
 * note of a run without it that skips `purpose`, because the step's inputs are unchanged since its last converge.
 * Any other run without it is refused with exit 2.
 */
export function externalAdminAccess(
  context: DockerContext,
  state: InstallerState,
  external: ExternalKeycloak,
  purpose: string,
): { credentials: AdminCredentials } | { skipped: string } {
  const lookup = lookupAdminCredentials(external, { env: process.env, readFile: readOptionalFile });
  if ("secret" in lookup) context.redactor.register(lookup.secret);
  return adminAccess(lookup, keycloakInputsUnchanged(context, state), purpose);
}

/** How the installer reaches an external Keycloak: trusting the system roots and keycloak.external.caBundleFile. */
export function externalKeycloakFetch(external: ExternalKeycloak): typeof fetch {
  if (external.caBundleFile === undefined) return fetch;
  const source = `${external.caBundleFile} (keycloak.external.caBundleFile)`;
  return trustingFetch(parseCertificates(readFileSync(external.caBundleFile, "utf8"), source).map(certificateToPem));
}

type TargetAccess = Pick<ConfigureTarget, "credentials" | "fetch">;

/** The admin access of an external Keycloak with the customer's credential, or the note of a run that skips it. */
function externalAccess(context: DockerContext, state: InstallerState, external: ExternalKeycloak): TargetAccess | { skipped: string } {
  const access = externalAdminAccess(context, state, external, STEP);
  if ("skipped" in access) return access;
  return { credentials: access.credentials, fetch: externalKeycloakFetch(external) };
}

/** The admin access of a managed Keycloak, libredb-installer through the loopback port, or why it is not there yet. */
async function managedAccess(context: DockerContext): Promise<TargetAccess | { pending: string }> {
  const container = (await projectContainers(context)).find((entry) => entry.service === "keycloak");
  if (container?.state !== "running" || container.health !== "healthy") {
    return { pending: "the managed Keycloak is not running and healthy yet, so apply the keycloak-deploy step first" };
  }
  const realm = context.desired.realm;
  const credentials = readInstallerCredentials({ installerEnvFile: INSTALLER_ENV_FILE, realm, redactor: context.redactor });
  if (credentials === undefined) {
    return {
      pending: `${INSTALLER_ENV_FILE} does not exist yet, so apply the keycloak-deploy step first, which hands access over`,
    };
  }
  return { credentials };
}

const TIMEOUT_MS = 30_000;

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
}

/** How the manual check reaches a realm that the site configured, with the two app client secrets only. */
export interface ManualProbe {
  /** The issuer both apps trust, `<keycloak.external.baseUrl>/realms/<realm>`. */
  issuer: string;
  realm: string;
  /** Where the installer reaches the Admin API, keycloak.external.adminUrl or the base URL. */
  adminUrl: string;
  clientSecrets: { studio: string; platform: string };
  /** A fetch that trusts the system roots and keycloak.external.caBundleFile. */
  fetch: typeof fetch;
  /** Receives one line per Keycloak request, never a token or a secret. */
  log: (line: string) => void;
}

async function answerOf<T>(probe: ManualProbe, what: string, send: () => Promise<Response>, read: (response: Response) => Promise<T>): Promise<HttpAnswer<T>> {
  try {
    const response = await send();
    probe.log(`keycloak ${what} ${response.status}`);
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status };
    }
    return { status: 200, body: await read(response) };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** Token introspection of an unknown token as a client, which tells whether Keycloak accepts the client's secret. */
async function introspect(probe: ManualProbe, clientId: string, clientSecret: string): Promise<HttpAnswer> {
  const url = `${probe.issuer}/protocol/openid-connect/token/introspect`;
  const form = { client_id: clientId, client_secret: clientSecret, token: randomBytes(24).toString("base64url") };
  return answerOf(
    probe,
    `POST ${new URL(url).pathname} as ${clientId}`,
    () =>
      probe.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    async (response) => {
      await response.body?.cancel();
      return undefined;
    },
  );
}

async function adminRead<T>(admin: KeycloakAdmin, path: string): Promise<HttpAnswer<T>> {
  try {
    const response = await admin.request<T>("GET", path);
    return response.status === 200 ? { status: 200, body: response.body } : { status: response.status };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/**
 * Reads what the manual check evaluates, with the two client secrets only: the issuer's discovery document, token
 * introspection as each app client, a client_credentials token of libredb-platform, and with it the users and the
 * clients of the realm that view-users and view-clients let the service account read.
 */
export async function observeManualKeycloak(probe: ManualProbe): Promise<ManualKeycloakObservation> {
  const discoveryUrl = `${probe.issuer}/.well-known/openid-configuration`;
  const discovery = await answerOf(
    probe,
    `GET ${new URL(discoveryUrl).pathname}`,
    () => probe.fetch(discoveryUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) }),
    async (response) => {
      const document = (await response.json()) as { issuer?: unknown };
      return { issuer: typeof document.issuer === "string" ? document.issuer : undefined };
    },
  );
  const introspection = [
    { clientId: APP_CLIENT_IDS.studio, answer: await introspect(probe, APP_CLIENT_IDS.studio, probe.clientSecrets.studio) },
    { clientId: APP_CLIENT_IDS.platform, answer: await introspect(probe, APP_CLIENT_IDS.platform, probe.clientSecrets.platform) },
  ];
  const credentials = { realm: probe.realm, clientId: APP_CLIENT_IDS.platform, clientSecret: probe.clientSecrets.platform };
  let token: HttpAnswer;
  try {
    const answer = await requestToken({ baseUrl: probe.adminUrl, log: probe.log, fetch: probe.fetch }, credentials);
    token = "token" in answer ? { status: 200 } : { status: answer.status };
  } catch (error) {
    token = { error: messageOf(error) };
  }
  const observation: ManualKeycloakObservation = { issuer: probe.issuer, realm: probe.realm, discovery, introspection, token };
  if (!("status" in token) || token.status !== 200) return observation;
  const admin = new KeycloakAdmin({ baseUrl: probe.adminUrl, credentials, log: probe.log, fetch: probe.fetch });
  const base = realmPath(probe.realm);
  const users = await adminRead(admin, `${base}/users?first=0&max=1&briefRepresentation=true`);
  const clients: { clientId: string; answer: HttpAnswer<ClientRepresentation[]> }[] = [];
  let roles: HttpAnswer<string[]> | undefined;
  for (const clientId of [ROLE_CLIENT_ID, APP_CLIENT_IDS.studio, APP_CLIENT_IDS.platform]) {
    const answer = await adminRead<(ClientRepresentation & { id: string })[]>(
      admin,
      `${base}/clients?clientId=${segment(clientId)}&first=0&max=2`,
    );
    clients.push({ clientId, answer });
    const [live] = "body" in answer ? (answer.body ?? []) : [];
    if (clientId === ROLE_CLIENT_ID && live !== undefined) {
      const read = await adminRead<RoleRepresentation[]>(admin, `${base}/clients/${segment(live.id)}/roles`);
      roles = "body" in read ? { status: 200, body: (read.body ?? []).map((role) => role.name) } : (read as HttpAnswer<string[]>);
    }
  }
  return { ...observation, directory: { users, clients, ...(roles === undefined ? {} : { roles }) } };
}

/** The manual check of the configuration's realm with the stored client secrets, or why it cannot run yet. */
async function manualObservation(
  context: DockerContext,
  external: ExternalKeycloak,
): Promise<{ manual: ManualKeycloakObservation; expected: ManualKeycloakExpectations } | { pending: string }> {
  const names = [CLIENT_SECRET_NAMES.studio, CLIENT_SECRET_NAMES.platform] as const;
  const stored = (await context.secrets.fingerprints()).values;
  const missing = names.filter((name) => stored[name] === undefined);
  if (missing.length > 0) {
    return { pending: `secrets ${missing.join(", ")} are not stored yet, so apply the secrets step first` };
  }
  const secrets = await context.secrets.get(names);
  const { desired } = context;
  const manual = await observeManualKeycloak({
    issuer: desired.issuer,
    realm: desired.realm,
    adminUrl: desired.keycloak.adminUrl,
    clientSecrets: { studio: secrets[CLIENT_SECRET_NAMES.studio], platform: secrets[CLIENT_SECRET_NAMES.platform] },
    fetch: externalKeycloakFetch(external),
    log: context.info,
  });
  const expectedObjects = desiredKeycloak({
    installation: desired,
    keycloak: context.config.keycloak,
    clientSecrets: undefined,
    passwordLocations: { firstAdmin: PASSWORD_FILES["first-admin"], userManager: PASSWORD_FILES["user-manager"] },
  });
  return { manual, expected: manualExpectations(expectedObjects, desired.issuer) };
}

/**
 * The realm as a converge target: a managed Keycloak's through libredb-installer, or the reused realm of an external
 * Keycloak through the customer's admin credential. Otherwise why it cannot be reached yet, or the note of a run that
 * skips the converge for want of the customer's credential.
 */
async function dockerTarget(
  context: DockerContext,
  state: InstallerState,
): Promise<ConfigureTarget | { pending: string } | { skipped: string }> {
  const names = [CLIENT_SECRET_NAMES.studio, CLIENT_SECRET_NAMES.platform] as const;
  const stored = (await context.secrets.fingerprints()).values;
  const missing = names.filter((name) => stored[name] === undefined);
  if (missing.length > 0) {
    return { pending: `secrets ${missing.join(", ")} are not generated yet, so apply the secrets step first` };
  }
  const { keycloak } = context.config;
  const access = keycloak.mode === "external" ? externalAccess(context, state, keycloak.external) : await managedAccess(context);
  if (!("credentials" in access)) return access;
  const secrets = await context.secrets.get(names);
  return {
    baseUrl: context.desired.keycloak.adminUrl,
    realm: context.desired.realm,
    ...access,
    desired: desiredKeycloak({
      installation: context.desired,
      keycloak,
      clientSecrets: { studio: secrets[CLIENT_SECRET_NAMES.studio], platform: secrets[CLIENT_SECRET_NAMES.platform] },
      passwordLocations: { firstAdmin: PASSWORD_FILES["first-admin"], userManager: PASSWORD_FILES["user-manager"] },
    }),
    passwordFiles: PASSWORD_FILES,
    owner: { uid: 0, gid: 0 },
    redactor: context.redactor,
    log: context.info,
  };
}

export const keycloakConfigureStep: Step<DockerContext, ConfigureObservation, ConfigureAction> = {
  name: STEP,
  inputs: configureInputs,
  async observe({ context, state }) {
    const { keycloak } = context.config;
    if (keycloak.mode === "external" && keycloak.external.provisioning === "manual") {
      return manualObservation(context, keycloak.external);
    }
    const target = await dockerTarget(context, state);
    if ("pending" in target || "skipped" in target) return target;
    return { desired: target.desired, observed: await observeKeycloak(target, state) };
  },
  plan(observation, { context }) {
    if ("pending" in observation) return [{ kind: "pending", reason: observation.pending, summary: summaryOf(context) }];
    if ("skipped" in observation) {
      context.warn(observation.skipped);
      return [];
    }
    if ("manual" in observation) {
      // The site owns the realm, so the step changes nothing in it and refuses one that differs from the export.
      checkManualKeycloak(observation.manual, observation.expected);
      return [];
    }
    return planKeycloak(observation.desired, observation.observed);
  },
  async apply(actions, { context, state }) {
    const converge: KeycloakAction[] = [];
    for (const action of actions) {
      if (action.kind === "pending") throw new Error(`cannot ${action.summary}: ${action.reason}`);
      converge.push(action);
    }
    const target = await dockerTarget(context, state);
    if ("pending" in target) throw new Error(`cannot ${summaryOf(context)}: ${target.pending}`);
    if ("skipped" in target) throw new Error(`cannot ${summaryOf(context)}: ${target.skipped}`);
    await applyKeycloak(converge, target, state);
  },
};
