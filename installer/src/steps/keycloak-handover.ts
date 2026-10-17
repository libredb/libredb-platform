// The access handover of a managed Keycloak. Keycloak first starts with the temporary bootstrap client
// libredb-bootstrap in realm master. With it the handover creates the installation's realm, with brute force
// detection, a password policy and saved login and admin events from the start, and the realm-scoped
// service client libredb-installer, whose service account holds the realm-management role realm-admin, stores that
// client's secret only in /opt/libredb/secrets/installer.env, proves a token as libredb-installer, deletes the
// bootstrap client and removes the bootstrap variables from Keycloak's env file. Every later run authenticates only
// as libredb-installer, so no master-realm credential outlives the first run.
// Each stage checks what exists first, so a handover that stopped halfway resumes where it stopped.
import { join } from "node:path";
import { applyFile, readOptionalFile } from "../adapters/host-fs";
import {
  KeycloakAdmin,
  KeycloakAdminError,
  requestToken,
  type ClientCredentials,
} from "../adapters/keycloak-admin";
import { ExitCode } from "../cli/exit-codes";
import { SECRETS_DIR } from "../docker/layout";
import { managedRealm } from "../keycloak/desired";
import { MANAGED_ATTRIBUTE } from "../keycloak/representations";
import type { Redactor } from "../log/redact";
import { generateSecret } from "../secrets/generate";

export const BOOTSTRAP_CLIENT_ID = "libredb-bootstrap";
export const INSTALLER_CLIENT_ID = "libredb-installer";
export const MASTER_REALM = "master";

export { MANAGED_ATTRIBUTE };

/** The 0600 root-owned file with the libredb-installer secret, which no container mounts. */
export const INSTALLER_ENV_FILE = join(SECRETS_DIR, "installer.env");

export const BOOTSTRAP_ID_VARIABLE = "KC_BOOTSTRAP_ADMIN_CLIENT_ID";
export const BOOTSTRAP_SECRET_VARIABLE = "KC_BOOTSTRAP_ADMIN_CLIENT_SECRET";
export const DB_PASSWORD_VARIABLE = "KC_DB_PASSWORD";
const INSTALLER_ID_VARIABLE = "KEYCLOAK_INSTALLER_CLIENT_ID";
const INSTALLER_SECRET_VARIABLE = "KEYCLOAK_INSTALLER_CLIENT_SECRET";

/** A handover that cannot proceed safely; it names what to fix and never holds a secret. */
export class HandoverError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = ExitCode.RuntimeFailure) {
    super(message);
    this.name = "HandoverError";
    this.exitCode = exitCode;
  }
}

/** Parses an env file of KEY=value lines, ignoring blank lines and comments. */
export function parseEnvFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) throw new Error("an env file line is not of the form KEY=value");
    entries.set(line.slice(0, at), line.slice(at + 1));
  }
  return entries;
}

function renderEnvFile(entries: readonly (readonly [string, string])[]): string {
  return entries.map(([key, value]) => `${key}=${value}\n`).join("");
}

/** The content of Keycloak's env file: the database password, and the bootstrap client until the handover is done. */
export function keycloakEnvContent(dbPassword: string, bootstrapSecret: string | undefined): string {
  const entries: [string, string][] = [[DB_PASSWORD_VARIABLE, dbPassword]];
  if (bootstrapSecret !== undefined) {
    entries.push([BOOTSTRAP_ID_VARIABLE, BOOTSTRAP_CLIENT_ID], [BOOTSTRAP_SECRET_VARIABLE, bootstrapSecret]);
  }
  return renderEnvFile(entries);
}

export interface HandoverTarget {
  /** The loopback base URL of Keycloak's port 8080, such as http://127.0.0.1:18080. */
  baseUrl: string;
  realm: string;
  /** Keycloak's env file, from which the handover removes the bootstrap variables. */
  keycloakEnvFile: string;
  /** Where the libredb-installer secret is kept. */
  installerEnvFile: string;
  /** The owner of both files: root in an install. */
  owner: { uid: number; gid: number };
  /** Receives every secret the handover reads or generates. */
  redactor: Redactor;
  /** Receives one line per Keycloak request. */
  log: (line: string) => void;
  fetch?: typeof fetch;
}

/** The bootstrap client secret in Keycloak's env file, or undefined once the handover removed it. */
export function readBootstrapSecret(target: Pick<HandoverTarget, "keycloakEnvFile" | "redactor">): string | undefined {
  const text = readOptionalFile(target.keycloakEnvFile);
  if (text === undefined) return undefined;
  const secret = parseEnvFile(text).get(BOOTSTRAP_SECRET_VARIABLE);
  if (secret !== undefined) target.redactor.register(secret);
  return secret;
}

/** The libredb-installer credentials from installer.env, or undefined when the file does not exist. */
export function readInstallerCredentials(
  target: Pick<HandoverTarget, "installerEnvFile" | "realm" | "redactor">,
): ClientCredentials | undefined {
  const text = readOptionalFile(target.installerEnvFile);
  if (text === undefined) return undefined;
  const secret = parseEnvFile(text).get(INSTALLER_SECRET_VARIABLE);
  if (secret === undefined || secret === "") {
    throw new HandoverError(`${target.installerEnvFile} holds no ${INSTALLER_SECRET_VARIABLE}`);
  }
  target.redactor.register(secret);
  return { realm: target.realm, clientId: INSTALLER_CLIENT_ID, clientSecret: secret };
}

const realmPath = (realm: string) => `/admin/realms/${encodeURIComponent(realm)}`;

/**
 * Proves the libredb-installer credentials: a token from the installation's realm that reads the realm.
 * Returns undefined when they work, or why they do not.
 */
export async function checkInstallerAccess(
  target: HandoverTarget,
  credentials: ClientCredentials,
): Promise<string | undefined> {
  const admin = new KeycloakAdmin({ baseUrl: target.baseUrl, credentials, log: target.log, fetch: target.fetch });
  try {
    await admin.get(realmPath(target.realm));
    return undefined;
  } catch (error) {
    if (error instanceof KeycloakAdminError) return error.message;
    throw error;
  }
}

/** An installation that kept neither a bootstrap client nor working libredb-installer credentials. */
function lostAccess(target: HandoverTarget, reason: string): HandoverError {
  return new HandoverError(
    `the installer cannot reach the Keycloak Admin API: ${reason}. ` +
      `${target.installerEnvFile} must hold the secret of client ${INSTALLER_CLIENT_ID} in realm ${target.realm}; ` +
      "restore it from a backup, or set the client's secret in the realm console and write it there",
  );
}

/** Requires working libredb-installer credentials, as every run after the handover does. */
export async function requireInstallerAccess(target: HandoverTarget): Promise<void> {
  const credentials = readInstallerCredentials(target);
  if (credentials === undefined) throw lostAccess(target, `${target.installerEnvFile} does not exist`);
  const failure = await checkInstallerAccess(target, credentials);
  if (failure !== undefined) throw lostAccess(target, failure);
}

interface Represented {
  id: string;
  attributes?: Record<string, unknown>;
}

function isManaged(object: { attributes?: Record<string, unknown> }): boolean {
  return object.attributes?.[MANAGED_ATTRIBUTE] === "true";
}

function unmanaged(kind: string): HandoverError {
  return new HandoverError(
    `${kind} exists without the attribute ${MANAGED_ATTRIBUTE}=true, so the installer did not create it and does ` +
      "not take it over; remove or rename it, or install with keycloak.mode external",
    ExitCode.UnsafeChangeRefused,
  );
}

/** Creates the realm with the settings that keycloak-configure converges later, or refuses one the installer did not create. */
async function ensureRealm(admin: KeycloakAdmin, realm: string): Promise<void> {
  const found = await admin.find<{ attributes?: Record<string, unknown> }>(realmPath(realm));
  if (found === undefined) {
    await admin.write("POST", "/admin/realms", managedRealm(realm), [201]);
    return;
  }
  if (!isManaged(found)) throw unmanaged(`realm ${realm}`);
}

function writeInstallerEnv(target: HandoverTarget, secret: string): void {
  applyFile({
    path: target.installerEnvFile,
    content: renderEnvFile([
      [INSTALLER_ID_VARIABLE, INSTALLER_CLIENT_ID],
      [INSTALLER_SECRET_VARIABLE, secret],
    ]),
    mode: 0o600,
    ...target.owner,
  });
}

/** The libredb-installer secret: the stored one, or a new one written to installer.env before Keycloak gets it. */
function installerSecret(target: HandoverTarget): string {
  const stored = readInstallerCredentials(target);
  if (stored !== undefined) return stored.clientSecret;
  const secret = generateSecret();
  target.redactor.register(secret);
  writeInstallerEnv(target, secret);
  return secret;
}

async function findClient(admin: KeycloakAdmin, realm: string, clientId: string): Promise<Represented | undefined> {
  const found = await admin.get<Represented[]>(
    `${realmPath(realm)}/clients?clientId=${encodeURIComponent(clientId)}&first=0&max=2`,
  );
  if (found.length > 1) throw new HandoverError(`realm ${realm} holds more than one client ${clientId}`);
  return found[0];
}

async function ensureInstallerClient(admin: KeycloakAdmin, realm: string, secret: string): Promise<string> {
  const desired = {
    clientId: INSTALLER_CLIENT_ID,
    name: "LibreDB installer",
    protocol: "openid-connect",
    enabled: true,
    publicClient: false,
    clientAuthenticatorType: "client-secret",
    secret,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    attributes: { [MANAGED_ATTRIBUTE]: "true" },
  };
  const existing = await findClient(admin, realm, INSTALLER_CLIENT_ID);
  if (existing === undefined) {
    await admin.write("POST", `${realmPath(realm)}/clients`, desired, [201]);
  } else {
    if (!isManaged(existing)) throw unmanaged(`client ${INSTALLER_CLIENT_ID} in realm ${realm}`);
    // A handover that stopped after creating the client converges it, its secret included, on the stored one.
    await admin.write("PUT", `${realmPath(realm)}/clients/${existing.id}`, {
      ...existing,
      ...desired,
      attributes: { ...existing.attributes, ...desired.attributes },
    });
  }
  const created = await findClient(admin, realm, INSTALLER_CLIENT_ID);
  if (created === undefined) throw new HandoverError(`client ${INSTALLER_CLIENT_ID} is missing right after its create`);
  return created.id;
}

/** Grants the service account of libredb-installer the realm-management role realm-admin, once. */
async function grantRealmAdmin(admin: KeycloakAdmin, realm: string, clientUuid: string): Promise<void> {
  const base = realmPath(realm);
  const account = await admin.get<{ id: string }>(`${base}/clients/${clientUuid}/service-account-user`);
  const management = await findClient(admin, realm, "realm-management");
  if (management === undefined) throw new HandoverError(`realm ${realm} has no realm-management client`);
  const mappingPath = `${base}/users/${account.id}/role-mappings/clients/${management.id}`;
  const mapped = await admin.get<{ name: string }[]>(mappingPath);
  if (mapped.some((role) => role.name === "realm-admin")) return;
  const role = await admin.get<{ id: string; name: string }>(`${base}/clients/${management.id}/roles/realm-admin`);
  await admin.write("POST", mappingPath, [role], [204]);
}

/** Deletes every client libredb-bootstrap of realm master; the bootstrap client may delete itself. */
async function deleteBootstrapClient(admin: KeycloakAdmin): Promise<void> {
  const found = await admin.get<Represented[]>(
    `${realmPath(MASTER_REALM)}/clients?clientId=${encodeURIComponent(BOOTSTRAP_CLIENT_ID)}`,
  );
  for (const client of found) {
    await admin.write("DELETE", `${realmPath(MASTER_REALM)}/clients/${client.id}`, undefined, [204]);
  }
}

/** Rewrites Keycloak's env file without the bootstrap variables, keeping its mode and owner. */
function removeBootstrapVariables(target: HandoverTarget): void {
  const text = readOptionalFile(target.keycloakEnvFile);
  if (text === undefined) throw new HandoverError(`${target.keycloakEnvFile} does not exist`);
  const kept = [...parseEnvFile(text)].filter(
    ([key]) => key !== BOOTSTRAP_ID_VARIABLE && key !== BOOTSTRAP_SECRET_VARIABLE,
  );
  applyFile({ path: target.keycloakEnvFile, content: renderEnvFile(kept), mode: 0o600, ...target.owner });
}

/**
 * Runs the handover with the bootstrap client found in Keycloak's env file. When Keycloak already refuses the
 * bootstrap client, an earlier handover deleted it, so working libredb-installer credentials let it finish by
 * removing the bootstrap variables.
 */
export async function runHandover(target: HandoverTarget): Promise<void> {
  const bootstrapSecret = readBootstrapSecret(target);
  if (bootstrapSecret === undefined) {
    throw new HandoverError(`${target.keycloakEnvFile} holds no ${BOOTSTRAP_SECRET_VARIABLE}, so there is nothing to hand over`);
  }
  const bootstrap: ClientCredentials = { realm: MASTER_REALM, clientId: BOOTSTRAP_CLIENT_ID, clientSecret: bootstrapSecret };
  const token = await requestToken({ baseUrl: target.baseUrl, log: target.log, fetch: target.fetch }, bootstrap);
  if ("status" in token) {
    await requireInstallerAccess(target);
    removeBootstrapVariables(target);
    return;
  }

  const master = new KeycloakAdmin({ baseUrl: target.baseUrl, credentials: bootstrap, log: target.log, fetch: target.fetch });
  await ensureRealm(master, target.realm);
  const secret = installerSecret(target);
  const clientUuid = await ensureInstallerClient(master, target.realm, secret);
  await grantRealmAdmin(master, target.realm, clientUuid);

  const failure = await checkInstallerAccess(target, {
    realm: target.realm,
    clientId: INSTALLER_CLIENT_ID,
    clientSecret: secret,
  });
  if (failure !== undefined) {
    throw new HandoverError(`the new client ${INSTALLER_CLIENT_ID} cannot read realm ${target.realm}: ${failure}`);
  }

  await deleteBootstrapClient(master);
  removeBootstrapVariables(target);
}
