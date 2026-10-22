// Runs the managed Keycloak of the rendered compose file against a PostgreSQL server provisioned as the
// postgres-provision step does, hands its access over to libredb-installer, then converges the LibreDB objects and the
// realm's settings with the keycloak-configure step's own observe, plan and apply, as libredb-installer through the
// loopback port. Keycloak's port 8080 is published on 127.0.0.1:LIBREDB_IT_KEYCLOAK_PORT (default 18080, the default
// keycloak.adminPort). LIBREDB_IT_PREFIX names the containers, the network and the scratch directory together with the
// infix -cfg (default libredb-it-kc-cfg), so this file never shares a container with the handover test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { DockerPsqlRunner } from "../../../src/adapters/psql-docker";
import { KeycloakAdmin, tokenPath } from "../../../src/adapters/keycloak-admin";
import { embeddedRelease } from "../../../src/cli/release";
import { loadConfig } from "../../../src/config/load";
import { desiredKeycloak, FIRST_LOGIN_ACTIONS, managedRealm, type Account } from "../../../src/keycloak/desired";
import { KeycloakConvergeError, planKeycloak, type KeycloakAction } from "../../../src/keycloak/planner";
import { idFromLocation } from "../../../src/keycloak/requests";
import { Redactor } from "../../../src/log/redact";
import { computeDesired } from "../../../src/model/desired";
import { renderCompose, renderPgHba } from "../../../src/render/compose";
import { generateSecret } from "../../../src/secrets/generate";
import { APP_ROLES, type AppRole } from "../../../src/sql/provision";
import { emptyState } from "../../../src/state/store";
import {
  applyKeycloak,
  createdUsers,
  observeKeycloak,
  type ConfigureTarget,
} from "../../../src/steps/keycloak-configure";
import { keycloakEnvContent, readInstallerCredentials, runHandover } from "../../../src/steps/keycloak-handover";
import {
  applyProvision,
  observeProvision,
  planProvisionRun,
  type ProvisionTarget,
} from "../../../src/steps/postgres-provision";
import { createCa } from "../../../src/tls/ca";
import { issueLeaf } from "../../../src/tls/leaf";
import { TRUST_FIXTURE } from "../../unit/render/fixture";

const PREFIX = `${process.env.LIBREDB_IT_PREFIX ?? "libredb-it-kc"}-cfg`;
const KEYCLOAK_PORT = Number(process.env.LIBREDB_IT_KEYCLOAK_PORT ?? "18080");
const NETWORK = `${PREFIX}-net`;
const POSTGRES = `${PREFIX}-postgres`;
const KEYCLOAK = `${PREFIX}-keycloak`;
const LONG = 15 * 60_000;
const REALM = "libredb";
const ADMIN_REALM = `/admin/realms/${REALM}`;

const packageRoot = join(import.meta.dir, "..", "..", "..");
const config = loadConfig({
  file: join(packageRoot, "test", "fixtures", "configs", "docker.yaml"),
  sets: [`keycloak.adminPort=${KEYCLOAK_PORT}`, "mobile.enabled=true"],
});
const installation = computeDesired(config, embeddedRelease());
const BASE_URL = installation.keycloak.adminUrl;
const FIRST_ADMIN = config.keycloak.firstAdmin.username;
const USER_MANAGER = config.keycloak.userManager.username;

interface ComposeService {
  image: string;
  command: string[];
  environment: Record<string, string>;
  healthcheck: { test: string[] };
}
const services = (parse(renderCompose(installation, TRUST_FIXTURE)) as { services: Record<string, ComposeService> }).services;

const scratch = mkdtempSync(join(tmpdir(), `${PREFIX}-`));
const redactor = new Redactor();
const superuserPassword = generateSecret();
const passwords = Object.fromEntries(APP_ROLES.map((role) => [role, generateSecret()])) as Record<AppRole, string>;
const keycloakEnvFile = join(scratch, "env", "keycloak.env");
const installerEnvFile = join(scratch, "secrets", "installer.env");
const passwordFiles: Record<Account, string> = {
  "first-admin": join(scratch, "secrets", "first-admin.txt"),
  "user-manager": join(scratch, "secrets", "user-manager.txt"),
};
const clientSecrets = { studio: generateSecret(), platform: generateSecret() };
const desired = desiredKeycloak({
  installation,
  keycloak: config.keycloak,
  clientSecrets,
  passwordLocations: { firstAdmin: passwordFiles["first-admin"], userManager: passwordFiles["user-manager"] },
});
const ALICE = { username: "alice", email: "alice@libredb.test", password: generateSecret() };
const state = emptyState();
const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

/** Every Keycloak request of the current run, as `METHOD path`. */
let requests: string[] = [];
const recordingFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
  return fetch(input, init);
}) as typeof fetch;

function docker(args: readonly string[], check = true): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`docker ${args.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

function removeEverything(): void {
  docker(["rm", "--force", "--volumes", KEYCLOAK, POSTGRES], false);
  const leftovers = docker(["ps", "--all", "--quiet", "--filter", `name=^${PREFIX}-psql-`]).stdout.split("\n").filter(Boolean);
  if (leftovers.length > 0) docker(["rm", "--force", ...leftovers], false);
  docker(["network", "rm", NETWORK], false);
}

async function waitFor(what: string, ready: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`${what} did not become ready within ${timeoutMs / 1000} s`);
    await Bun.sleep(1000);
  }
}

async function startPostgres(): Promise<void> {
  const ca = await createCa({ commonName: `${PREFIX} test CA`, now: new Date() });
  writeFileSync(join(scratch, "ca", "ca.crt"), ca.certPem, { mode: 0o644 });
  const tls = join(scratch, "pg");
  mkdirSync(tls, { mode: 0o755 });
  chmodSync(tls, 0o755);
  const leaf = await issueLeaf(ca, ["postgres"], new Date());
  writeFileSync(join(tls, "server.crt"), leaf.certPem, { mode: 0o644 });
  // A throwaway test key, copied into the server container with mode 0600 at start.
  writeFileSync(join(tls, "server.key"), leaf.keyPem, { mode: 0o644 });
  writeFileSync(join(tls, "pg_hba.conf"), renderPgHba(), { mode: 0o644 });
  writeFileSync(join(scratch, "postgres.env"), `POSTGRES_PASSWORD=${superuserPassword}\n`, { mode: 0o600 });
  docker([
    "run",
    "--detach",
    "--name",
    POSTGRES,
    "--network",
    NETWORK,
    "--network-alias",
    "postgres",
    "--env-file",
    join(scratch, "postgres.env"),
    "--env",
    "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256",
    "--volume",
    `${tls}:/etc/libredb-it/source:ro`,
    "--entrypoint",
    "sh",
    installation.images.postgres,
    "-c",
    [
      "install -d -m 0700 -o postgres -g postgres /etc/libredb-it/tls",
      "install -m 0600 -o postgres -g postgres /etc/libredb-it/source/server.key /etc/libredb-it/tls/server.key",
      "install -m 0644 -o postgres -g postgres /etc/libredb-it/source/server.crt /etc/libredb-it/tls/server.crt",
      "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/libredb-it/tls/server.crt " +
        "-c ssl_key_file=/etc/libredb-it/tls/server.key -c hba_file=/etc/libredb-it/source/pg_hba.conf " +
        "-c password_encryption=scram-sha-256",
    ].join(" && "),
  ]);
  await waitFor(
    POSTGRES,
    () => docker(["exec", POSTGRES, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], false).code === 0,
    120_000,
  );
  const target: ProvisionTarget = {
    runner: new DockerPsqlRunner({
      image: installation.images.postgres,
      network: NETWORK,
      caBundleFile: join(scratch, "ca", "ca.crt"),
      envDir: join(scratch, "env"),
      redactor,
      log: () => {},
      namePrefix: `${PREFIX}-psql`,
    }),
    admin: { host: "postgres", port: 5432, database: "postgres", user: "postgres", password: superuserPassword },
    server: { host: "postgres", port: 5432 },
    passwords,
    managedKeycloak: true,
    redactor,
  };
  const provisionState = emptyState();
  await applyProvision(planProvisionRun(await observeProvision(target), target, provisionState), target, provisionState, () => {});
}

async function startKeycloak(): Promise<void> {
  const keycloak = services.keycloak;
  if (keycloak === undefined) throw new Error("the rendered compose file has no keycloak service");
  const [kind, ...healthCommand] = keycloak.healthcheck.test;
  if (kind !== "CMD") throw new Error(`unexpected healthcheck form ${kind}`);
  writeFileSync(keycloakEnvFile, keycloakEnvContent(passwords.keycloak, generateSecret()), { mode: 0o600 });
  docker([
    "run",
    "--detach",
    "--name",
    KEYCLOAK,
    "--network",
    NETWORK,
    "--network-alias",
    "keycloak",
    "--publish",
    `127.0.0.1:${KEYCLOAK_PORT}:8080`,
    "--env-file",
    keycloakEnvFile,
    ...Object.entries(keycloak.environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--volume",
    `${join(scratch, "ca")}:/etc/libredb/ca:ro`,
    "--health-cmd",
    // docker run takes a shell command, so quote the rendered exec form for /bin/sh.
    healthCommand.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" "),
    "--health-interval",
    "5s",
    "--health-retries",
    "60",
    keycloak.image,
    ...keycloak.command,
  ]);
  await waitFor(
    KEYCLOAK,
    () => docker(["inspect", "--format", "{{.State.Health.Status}}", KEYCLOAK]).stdout.trim() === "healthy",
    600_000,
  );
}

function target(): ConfigureTarget {
  const credentials = readInstallerCredentials({ installerEnvFile, realm: REALM, redactor });
  if (credentials === undefined) throw new Error("the handover wrote no installer.env");
  return {
    baseUrl: BASE_URL,
    realm: REALM,
    credentials,
    desired,
    passwordFiles,
    owner,
    redactor,
    log: () => {},
    fetch: recordingFetch,
  };
}

/** Plans against the realm as the step's observe and plan do. */
async function plan(): Promise<KeycloakAction[]> {
  return planKeycloak(desired, await observeKeycloak(target(), state));
}

/** Plans and applies, as the step does, and returns what it applied. */
async function converge(): Promise<KeycloakAction[]> {
  const actions = await plan();
  await applyKeycloak(actions, target(), state);
  return actions;
}

/** The Admin API as libredb-installer, standing in for an operator in the realm console. */
function operator(): KeycloakAdmin {
  return new KeycloakAdmin({ baseUrl: BASE_URL, credentials: target().credentials, log: () => {} });
}

async function clientOf(clientId: string): Promise<Record<string, unknown> & { id: string }> {
  const [client] = await operator().get<(Record<string, unknown> & { id: string })[]>(
    `${ADMIN_REALM}/clients?clientId=${clientId}`,
  );
  if (client === undefined) throw new Error(`realm ${REALM} has no client ${clientId}`);
  return client;
}

/** Changes a client as the console does, sending its representation without the protocol mappers. */
async function editClient(clientId: string, change: Record<string, unknown>): Promise<void> {
  const { protocolMappers: _mappers, ...client } = await clientOf(clientId);
  await operator().write("PUT", `${ADMIN_REALM}/clients/${client.id}`, { ...client, ...change });
}

async function userOf(username: string): Promise<Record<string, unknown> & { id: string }> {
  const [user] = await operator().get<(Record<string, unknown> & { id: string })[]>(
    `${ADMIN_REALM}/users?username=${username}&exact=true`,
  );
  if (user === undefined) throw new Error(`realm ${REALM} has no user ${username}`);
  return user;
}

async function roleRef(clientUuid: string, role: string): Promise<{ id: string; name: string }> {
  const found = await operator().get<{ id: string; name: string }>(`${ADMIN_REALM}/clients/${clientUuid}/roles/${role}`);
  return { id: found.id, name: found.name };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (payload === undefined) throw new Error("not a compact JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function tokenFor(form: Record<string, string>): Promise<string> {
  const response = await fetch(`${BASE_URL}${tokenPath(REALM)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body = (await response.json()) as { access_token?: string; error_description?: string };
  if (body.access_token === undefined) throw new Error(`no token: ${response.status} ${body.error_description ?? ""}`);
  return body.access_token;
}

/** A password-grant token of the realm's public admin-cli client, the client the realm console's login stands for. */
const userToken = (username: string, password: string) =>
  tokenFor({ grant_type: "password", client_id: "admin-cli", username, password });

/**
 * An authorization-code login with PKCE through the login form, with the form posted to the loopback port, as a
 * confidential client with its secret or as a public client without one. Returns the claims of both tokens.
 */
async function codeLoginTokens(
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string,
): Promise<{ id: Record<string, unknown>; access: Record<string, unknown> }> {
  const oidc = `${BASE_URL}/realms/${REALM}/protocol/openid-connect`;
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorize = new URL(`${oidc}/auth`);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const page = await fetch(authorize, { redirect: "manual" });
  expect(page.status).toBe(200);
  const cookies = page.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0])
    .join("; ");
  const form = /<form\b[^>]*\bid="kc-form-login"[^>]*>/.exec(await page.text())?.[0];
  const action = form === undefined ? undefined : /\baction="([^"]+)"/.exec(form)?.[1]?.replaceAll("&amp;", "&");
  if (action === undefined) throw new Error("the login page has no form kc-form-login with an action");
  // Keycloak names its public URL in the form; the test reaches the same Keycloak through the loopback port.
  const publicAction = new URL(action);
  const submitted = await fetch(`${BASE_URL}${publicAction.pathname}${publicAction.search}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
    body: new URLSearchParams({ username: ALICE.username, password: ALICE.password, credentialId: "" }),
  });
  const location = submitted.headers.get("location") ?? "";
  expect({ status: submitted.status, toRedirectUri: location.startsWith(redirectUri) }).toEqual({ status: 302, toRedirectUri: true });
  const callback = new URL(location);
  expect(callback.searchParams.get("state")).toBe(state);
  const response = await fetch(`${oidc}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
    }),
  });
  expect(response.status).toBe(200);
  const tokens = (await response.json()) as { id_token: string; access_token: string };
  const claims = decodeJwtPayload(tokens.id_token);
  expect(claims.nonce).toBe(nonce);
  return { id: claims, access: decodeJwtPayload(tokens.access_token) };
}

/** The claims of the ID token of codeLoginTokens. */
async function codeLogin(clientId: string, clientSecret: string, redirectUri: string): Promise<Record<string, unknown>> {
  return (await codeLoginTokens(clientId, clientSecret, redirectUri)).id;
}

/** The status of a password-grant token request of the realm's admin-cli client, which signs a user in. */
async function signInStatus(username: string, password: string): Promise<number> {
  const response = await fetch(`${BASE_URL}${tokenPath(REALM)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username, password }),
  });
  await response.body?.cancel();
  return response.status;
}

/**
 * A browser on Keycloak's login pages: it keeps their cookies and sends every request to the loopback port, while the
 * pages and redirects name Keycloak's public URL.
 */
class LoginPages {
  readonly #cookies = new Map<string, string>();

  async send(url: string, form?: Record<string, string>): Promise<Response> {
    const target = new URL(url);
    const response = await fetch(`${BASE_URL}${target.pathname}${target.search}`, {
      method: form === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";", 1);
      const at = pair.indexOf("=");
      if (at > 0) this.#cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  }
}

/** The action of the form with this id on a Keycloak page, or undefined when the page has no such form. */
function formAction(html: string, id: string): string | undefined {
  const form = new RegExp(`<form\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0];
  return form === undefined ? undefined : /\baction="([^"]+)"/.exec(form)?.[1]?.replaceAll("&amp;", "&");
}

/** The RFC 6238 code of the raw TOTP secret that Keycloak's setup form holds: HMAC-SHA1, 30-second steps, 6 digits. */
function totp(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", Buffer.from(secret, "utf8")).update(counter).digest();
  const offset = (digest.at(-1) as number) & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

type RequiredAction = "password" | "totp" | "profile";

/**
 * The first login of an account with its temporary password through libredb-studio: it completes every required action
 * in the order Keycloak asks for them, offering each of `refused` as the new password before `user.password`. Returns
 * the actions in that order and the alert Keycloak showed for each refused password.
 */
async function firstLogin(
  user: { username: string; temporary: string; password: string },
  refused: readonly string[],
): Promise<{ completed: RequiredAction[]; refusals: string[] }> {
  const pages = new LoginPages();
  const redirectUri = installation.clients.studio.redirectUri;
  const authorize = new URL(`${BASE_URL}/realms/${REALM}/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({
    client_id: "libredb-studio",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
    state: randomBytes(16).toString("base64url"),
    code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const login = formAction(await (await pages.send(authorize.toString())).text(), "kc-form-login");
  if (login === undefined) throw new Error("the login page has no form kc-form-login");
  let response = await pages.send(login, { username: user.username, password: user.temporary, credentialId: "" });
  const completed: RequiredAction[] = [];
  const refusals: string[] = [];
  for (;;) {
    if (response.status === 302) {
      const location = response.headers.get("location") ?? "";
      if (location.startsWith(redirectUri)) return { completed, refusals };
      response = await pages.send(location);
      continue;
    }
    const html = await response.text();
    const forms: Record<RequiredAction, string | undefined> = {
      password: formAction(html, "kc-passwd-update-form"),
      totp: formAction(html, "kc-totp-settings-form"),
      profile: formAction(html, "kc-update-profile-form"),
    };
    const stage = (["password", "totp", "profile"] as const).find((name) => forms[name] !== undefined);
    const action = stage === undefined ? undefined : forms[stage];
    if (stage === undefined || action === undefined) {
      throw new Error(`Keycloak answered ${response.status} without a required action form`);
    }
    if (completed.includes(stage)) throw new Error(`Keycloak asked for the ${stage} action again`);
    completed.push(stage);
    if (stage === "password") {
      let form = action;
      for (const password of refused) {
        const page = await (await pages.send(form, { "password-new": password, "password-confirm": password })).text();
        refusals.push(/<span class="pf-v5-c-alert__title kc-feedback-text">([^<]*)<\/span>/.exec(page)?.[1] ?? "no alert");
        const again = formAction(page, "kc-passwd-update-form");
        if (again === undefined) throw new Error("Keycloak accepted a password that the policy refuses");
        form = again;
      }
      response = await pages.send(form, { "password-new": user.password, "password-confirm": user.password });
    } else if (stage === "totp") {
      const secret = /\bname="totpSecret" value="([^"]+)"/.exec(html)?.[1];
      if (secret === undefined) throw new Error("the TOTP setup page holds no totpSecret");
      response = await pages.send(action, { totp: totp(secret), totpSecret: secret, userLabel: "test device" });
    } else {
      const profile = { email: `${user.username}@libredb.test`, firstName: "Test", lastName: user.username };
      response = await pages.send(action, profile);
    }
  }
}

const summaries = (actions: readonly KeycloakAction[]) => actions.map((action) => action.summary);

beforeAll(async () => {
  removeEverything();
  for (const dir of ["ca", "env", "secrets"]) mkdirSync(join(scratch, dir), { mode: dir === "ca" ? 0o755 : 0o700 });
  chmodSync(join(scratch, "ca"), 0o755);
  docker(["network", "create", NETWORK]);
  await startPostgres();
  await startKeycloak();
  await runHandover({
    baseUrl: BASE_URL,
    realm: REALM,
    keycloakEnvFile,
    installerEnvFile,
    owner,
    redactor,
    log: () => {},
  });
  expect((await converge()).length).toBe(18);
  // The realm's own test user, holding libredb:admin directly, as an admin assigns it in the realm console.
  const created = await operator().write(
    "POST",
    `${ADMIN_REALM}/users`,
    {
      username: ALICE.username,
      email: ALICE.email,
      emailVerified: true,
      firstName: "Alice",
      lastName: "Admin",
      enabled: true,
      credentials: [{ type: "password", value: ALICE.password, temporary: false }],
    },
    [201],
  );
  const libredb = await clientOf("libredb");
  await operator().write(
    "POST",
    `${ADMIN_REALM}/users/${idFromLocation(created.location, "user alice")}/role-mappings/clients/${libredb.id}`,
    [await roleRef(libredb.id, "admin")],
    [204],
  );
  // Hardening some sites apply: tokens carry only the roles in a client's scope.
  for (const clientId of ["libredb-studio", "libredb-platform", "libredb-mobile"]) {
    await editClient(clientId, { fullScopeAllowed: false });
  }
}, LONG);

afterAll(() => {
  removeEverything();
  rmSync(scratch, { recursive: true, force: true });
});

describe("keycloak configure", () => {
  test("with Full Scope Allowed off on both app clients, an authorization-code login with PKCE of a user holding libredb:admin yields an ID token with an email claim and a libredb_roles claim that is the one-element array admin", async () => {
    for (const clientId of ["libredb-studio", "libredb-platform"]) expect((await clientOf(clientId)).fullScopeAllowed).toBe(false);
    const logins = [
      { clientId: "libredb-studio", secret: clientSecrets.studio, redirectUri: installation.clients.studio.redirectUri },
      { clientId: "libredb-platform", secret: clientSecrets.platform, redirectUri: installation.clients.platform.redirectUri },
    ];
    for (const login of logins) {
      const claims = await codeLogin(login.clientId, login.secret, login.redirectUri);
      expect({ client: login.clientId, iss: claims.iss, email: claims.email, libredb_roles: claims.libredb_roles }).toEqual({
        client: login.clientId,
        iss: installation.issuer,
        email: ALICE.email,
        libredb_roles: ["admin"],
      });
    }
  });

  test("with Full Scope Allowed off, a PKCE login through the public client libredb-mobile without a secret yields an access token for Studio's bearer channel and an ID token with the role, and the password grant is refused", async () => {
    const mobile = installation.clients.mobile;
    if (mobile === undefined) throw new Error("the configuration does not enable the mobile app");
    expect(await clientOf("libredb-mobile")).toMatchObject({ publicClient: true, fullScopeAllowed: false });
    const { id, access } = await codeLoginTokens("libredb-mobile", undefined, mobile.redirectUri);
    expect({ iss: id.iss, azp: id.azp, libredb_roles: id.libredb_roles }).toEqual({
      iss: installation.issuer,
      azp: "libredb-mobile",
      libredb_roles: ["admin"],
    });
    // What Studio's bearer channel reads: its audience and never libredb-studio's, the client, the role and an identity.
    const audience = typeof access.aud === "string" ? [access.aud] : (access.aud as string[]);
    expect(audience).toContain("libredb-studio-api");
    expect(audience).not.toContain("libredb-studio");
    expect({
      iss: access.iss,
      azp: access.azp,
      typ: access.typ,
      libredb_roles: access.libredb_roles,
      email: access.email,
      preferred_username: access.preferred_username,
      sub: access.sub,
    }).toEqual({
      iss: installation.issuer,
      azp: "libredb-mobile",
      typ: "Bearer",
      libredb_roles: ["admin"],
      email: ALICE.email,
      preferred_username: ALICE.username,
      sub: id.sub,
    });
    const password = await fetch(`${BASE_URL}${tokenPath(REALM)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "libredb-mobile",
        username: ALICE.username,
        password: ALICE.password,
      }),
    });
    expect({ status: password.status, body: await password.json() }).toMatchObject({
      status: 400,
      body: { error: "unauthorized_client" },
    });
  });

  test("a libredb-platform client-credentials token gets 200 on GET /admin/realms/libredb/clients/{libredb}/roles/admin/users and 403 on POST /admin/realms/libredb/users", async () => {
    const token = await tokenFor({
      grant_type: "client_credentials",
      client_id: "libredb-platform",
      client_secret: clientSecrets.platform,
    });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const libredb = await clientOf("libredb");
    const members = await fetch(`${BASE_URL}${ADMIN_REALM}/clients/${libredb.id}/roles/admin/users`, { headers });
    expect(members.status).toBe(200);
    const usernames = ((await members.json()) as { username: string }[]).map((user) => user.username).sort();
    expect(usernames).toEqual([ALICE.username, FIRST_ADMIN].sort());
    const create = await fetch(`${BASE_URL}${ADMIN_REALM}/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "mallory", enabled: true }),
    });
    expect(create.status).toBe(403);
  });

  test("the user manager, with required actions cleared by the test, creates a user and assigns libredb:user in realm libredb, and the first admin gets 403 on the same user create", async () => {
    // Keycloak 26's default user profile asks for email and names at the first login too, so the test fills them in.
    for (const username of [USER_MANAGER, FIRST_ADMIN]) {
      const user = await userOf(username);
      await operator().write("PUT", `${ADMIN_REALM}/users/${user.id}`, {
        ...user,
        requiredActions: [],
        email: `${username}@libredb.test`,
        emailVerified: true,
        firstName: "Test",
        lastName: username,
      });
    }
    const temporary = (account: Account) => readFileSync(passwordFiles[account], "utf8").trim();
    const managerHeaders = {
      authorization: `Bearer ${await userToken(USER_MANAGER, temporary("user-manager"))}`,
      "content-type": "application/json",
    };
    const bob = { username: "bob", enabled: true, email: "bob@libredb.test", firstName: "Bob", lastName: "User" };
    const created = await fetch(`${BASE_URL}${ADMIN_REALM}/users`, { method: "POST", headers: managerHeaders, body: JSON.stringify(bob) });
    expect(created.status).toBe(201);
    const bobId = idFromLocation(created.headers.get("location"), "user bob");
    // The user manager finds the role as the realm console does, then assigns it.
    const found = await fetch(`${BASE_URL}${ADMIN_REALM}/clients?clientId=libredb`, { headers: managerHeaders });
    expect(found.status).toBe(200);
    const [libredb] = (await found.json()) as { id: string }[];
    if (libredb === undefined) throw new Error("the user manager does not see client libredb");
    const role = await fetch(`${BASE_URL}${ADMIN_REALM}/clients/${libredb.id}/roles/user`, { headers: managerHeaders });
    expect(role.status).toBe(200);
    const { id, name } = (await role.json()) as { id: string; name: string };
    const assigned = await fetch(`${BASE_URL}${ADMIN_REALM}/users/${bobId}/role-mappings/clients/${libredb.id}`, {
      method: "POST",
      headers: managerHeaders,
      body: JSON.stringify([{ id, name }]),
    });
    expect(assigned.status).toBe(204);
    const held = await operator().get<{ name: string }[]>(`${ADMIN_REALM}/users/${bobId}/role-mappings/clients/${libredb.id}`);
    expect(held.map((entry) => entry.name)).toEqual(["user"]);

    const adminHeaders = {
      authorization: `Bearer ${await userToken(FIRST_ADMIN, temporary("first-admin"))}`,
      "content-type": "application/json",
    };
    const refused = await fetch(`${BASE_URL}${ADMIN_REALM}/users`, { method: "POST", headers: adminHeaders, body: JSON.stringify(bob) });
    expect(refused.status).toBe(403);
  });

  test("a second converge plans nothing and reads the Admin API with GET requests only, and the accounts' passwords are never reset", async () => {
    const credentials = async () =>
      Promise.all(
        [FIRST_ADMIN, USER_MANAGER].map(async (username) =>
          operator().get<{ id: string; createdDate: number }[]>(`${ADMIN_REALM}/users/${(await userOf(username)).id}/credentials`),
        ),
      );
    const before = await credentials();
    requests = [];
    expect(await converge()).toEqual([]);
    const adminRequests = requests.filter((request) => request.includes("/admin/"));
    expect(adminRequests.length).toBeGreaterThan(0);
    expect(adminRequests.filter((request) => !request.startsWith("GET "))).toEqual([]);
    expect(await credentials()).toEqual(before);
    for (const file of Object.values(passwordFiles)) expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(createdUsers(state).sort()).toEqual([FIRST_ADMIN, USER_MANAGER].sort());
  });

  test("after the libredb-studio redirect URI is edited in the console the plan holds exactly one update client libredb-studio action, and a regenerated client secret converges back to the stored one", async () => {
    await editClient("libredb-studio", { redirectUris: ["https://studio.libredb.test/edited/callback"] });
    expect(summaries(await plan())).toEqual(["update client libredb-studio (redirectUris)"]);

    const studio = await clientOf("libredb-studio");
    await operator().write("POST", `${ADMIN_REALM}/clients/${studio.id}/client-secret`, undefined, [200]);
    expect(summaries(await converge())).toEqual(["update client libredb-studio (secret, redirectUris)"]);
    const converged = await clientOf("libredb-studio");
    expect({ secret: converged.secret === clientSecrets.studio, redirectUris: converged.redirectUris }).toEqual({
      secret: true,
      redirectUris: [installation.clients.studio.redirectUri],
    });
    // The console's own setting survives the update.
    expect(converged.fullScopeAllowed).toBe(false);
    expect(await plan()).toEqual([]);
  });

  test("a pairwise subject mapper on libredb-platform stops the converge with exit 3", async () => {
    const platform = await clientOf("libredb-platform");
    const added = await operator().write(
      "POST",
      `${ADMIN_REALM}/clients/${platform.id}/protocol-mappers/models`,
      {
        name: "pairwise subject",
        protocol: "openid-connect",
        protocolMapper: "oidc-sha256-pairwise-sub-mapper",
        config: { sectorIdentifierUri: "", pairwiseSubAlgorithmSalt: "" },
      },
      [201],
    );
    const error = await plan().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KeycloakConvergeError);
    expect((error as KeycloakConvergeError).exitCode).toBe(3);
    expect((error as KeycloakConvergeError).message).toContain("client libredb-platform has the mapper pairwise subject");
    await operator().write(
      "DELETE",
      `${ADMIN_REALM}/clients/${platform.id}/protocol-mappers/models/${idFromLocation(added.location, "mapper")}`,
      undefined,
      [204],
    );
    expect(await plan()).toEqual([]);
  });

  test("after the brute force detection, the password policy and the event expiration are loosened in the console, the plan holds exactly one update realm libredb action, and the converge restores them and keeps the realm's other settings", async () => {
    const live = await operator().get<Record<string, unknown> & { attributes: Record<string, string> }>(ADMIN_REALM);
    await operator().write("PUT", ADMIN_REALM, {
      ...live,
      bruteForceProtected: false,
      passwordPolicy: "length(8)",
      eventsExpiration: 3600,
      displayName: "LibreDB Operations",
      attributes: { ...live.attributes, adminEventsExpiration: "3600", "site.note": "kept" },
    });
    const update = "update realm libredb (bruteForceProtected, passwordPolicy, eventsExpiration, adminEventsExpiration)";
    expect(summaries(await plan())).toEqual([update]);
    expect(summaries(await converge())).toEqual([update]);
    const converged = await operator().get<Record<string, unknown> & { attributes: Record<string, string> }>(ADMIN_REALM);
    expect(converged).toMatchObject(managedRealm(REALM));
    expect({ displayName: converged.displayName, note: converged.attributes["site.note"] }).toEqual({
      displayName: "LibreDB Operations",
      note: "kept",
    });
    expect(await plan()).toEqual([]);
  });

  test("the password policy refuses a user created with a password shorter than 15 characters, and the installer's temporary passwords have 43", async () => {
    const short = await operator().request("POST", `${ADMIN_REALM}/users`, {
      username: "shorty",
      enabled: true,
      credentials: [{ type: "password", value: "fourteen-chars", temporary: true }],
    });
    expect({ status: short.status, body: short.body }).toEqual({
      status: 400,
      body: { error: "invalidPasswordMinLengthMessage", error_description: "Invalid password: minimum length 15." },
    });
    expect(await operator().get<unknown[]>(`${ADMIN_REALM}/users?username=shorty&exact=true`)).toEqual([]);
    for (const file of Object.values(passwordFiles)) expect(readFileSync(file, "utf8").trim()).toHaveLength(43);
  });

  test("an account created as the installer creates its accounts completes its first login: its temporary password and a 14-character password are refused as the new one, and a new password, a TOTP device and the profile complete the sign-in", async () => {
    const frank = { username: "frank", temporary: generateSecret(), password: `frank-${generateSecret().slice(0, 16)}` };
    // The body of the installer's create-user request.
    const created = await operator().write(
      "POST",
      `${ADMIN_REALM}/users`,
      {
        username: frank.username,
        enabled: true,
        requiredActions: [...FIRST_LOGIN_ACTIONS],
        credentials: [{ type: "password", value: frank.temporary, temporary: true }],
      },
      [201],
    );
    const id = idFromLocation(created.location, "user frank");
    const result = await firstLogin(frank, [frank.temporary, "fourteen-chars"]);
    expect(result.refusals).toEqual([
      "Invalid password: must not be equal to any of last 3 passwords.",
      "Invalid password: minimum length 15.",
    ]);
    expect([...result.completed].sort()).toEqual(["password", "profile", "totp"]);
    expect((await operator().get<{ requiredActions: string[] }>(`${ADMIN_REALM}/users/${id}`)).requiredActions).toEqual([]);
    // The temporary password stays as password history, which the policy compares a later new password with.
    const credentials = await operator().get<{ type: string }[]>(`${ADMIN_REALM}/users/${id}/credentials`);
    expect(credentials.map((credential) => credential.type).sort()).toEqual(["otp", "password", "password-history"]);
  }, LONG);

  test("five failed sign-ins lock an account for a minute, so its correct password is refused until an administrator lifts the lock", async () => {
    const eve = { username: "eve", password: generateSecret() };
    const created = await operator().write(
      "POST",
      `${ADMIN_REALM}/users`,
      {
        username: eve.username,
        email: "eve@libredb.test",
        emailVerified: true,
        firstName: "Eve",
        lastName: "Tester",
        enabled: true,
        credentials: [{ type: "password", value: eve.password, temporary: false }],
      },
      [201],
    );
    const lock = `${ADMIN_REALM}/attack-detection/brute-force/users/${idFromLocation(created.location, "user eve")}`;
    for (let failure = 1; failure <= 4; failure += 1) {
      expect(await signInStatus(eve.username, `wrong-${generateSecret()}`)).toBe(400);
      // A failure within a second of the one before counts as a quick login, which locks the account at once.
      await Bun.sleep(1_100);
    }
    expect(await operator().get<Record<string, unknown>>(lock)).toMatchObject({ numFailures: 4, disabled: false });
    expect(await signInStatus(eve.username, `wrong-${generateSecret()}`)).toBe(400);
    type LoginFailures = { numFailures: number; disabled: boolean; failedLoginNotBefore: number; lastFailure: number };
    const locked = await operator().get<LoginFailures>(lock);
    expect({
      numFailures: locked.numFailures,
      disabled: locked.disabled,
      lockedSeconds: locked.failedLoginNotBefore - Math.floor(locked.lastFailure / 1000),
    }).toEqual({ numFailures: 5, disabled: true, lockedSeconds: 60 });
    expect(await signInStatus(eve.username, eve.password)).toBe(400);
    await operator().write("DELETE", lock, undefined, [204]);
    expect(await signInStatus(eve.username, eve.password)).toBe(200);
  }, LONG);

  test("the realm saves login events and admin events with their representation, which names the role a mapping grants and holds no temporary password or client secret", async () => {
    const alice = await userOf(ALICE.username);
    const logins = await operator().get<{ type: string; userId: string; clientId: string }[]>(
      `${ADMIN_REALM}/events?type=LOGIN&max=1000`,
    );
    expect(logins.filter((event) => event.userId === alice.id).map((event) => event.clientId).sort()).toEqual([
      "libredb-mobile",
      "libredb-platform",
      "libredb-studio",
    ]);

    const events = await operator().get<{ operationType: string; resourcePath: string; representation?: string }[]>(
      `${ADMIN_REALM}/admin-events?max=1000`,
    );
    const firstAdmin = await userOf(FIRST_ADMIN);
    const libredb = await clientOf("libredb");
    const representationOf = (operationType: string, resourcePath: string): unknown => {
      const event = events.find((found) => found.operationType === operationType && found.resourcePath === resourcePath);
      if (event?.representation === undefined) {
        throw new Error(`no admin event ${operationType} ${resourcePath} with a representation`);
      }
      return JSON.parse(event.representation);
    };
    expect(representationOf("CREATE", `users/${firstAdmin.id}`)).toEqual({
      username: FIRST_ADMIN,
      enabled: true,
      requiredActions: [...FIRST_LOGIN_ACTIONS],
    });
    const granted = representationOf("CREATE", `users/${firstAdmin.id}/role-mappings/clients/${libredb.id}`) as { name: string }[];
    expect(granted.map((role) => role.name)).toEqual(["admin"]);
    const temporaryPasswords = Object.values(passwordFiles).map((file) => readFileSync(file, "utf8").trim());
    const secrets = [...temporaryPasswords, ...Object.values(clientSecrets)];
    const leaked = events.filter((event) => secrets.some((secret) => (event.representation ?? "").includes(secret)));
    expect(leaked.map((event) => `${event.operationType} ${event.resourcePath}`)).toEqual([]);
  });
});
