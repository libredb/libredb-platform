// Reuses realm corp of a customer's Keycloak, which runs from the pinned Keycloak image in dev mode with TLS from a
// test CA, and converges the LibreDB objects into it with the preflight and keycloak-configure steps' own observe,
// check, plan and apply, as an administrator of realm master through admin-cli: no libredb-installer client, no realm
// import and no change to the realm's settings, its realm roles or its users' realm-management roles.
// Keycloak's HTTPS port is published on 127.0.0.1:LIBREDB_IT_KEYCLOAK_PORT (default 18080). LIBREDB_IT_PREFIX names the
// container and the scratch directory together with the infix -reuse (default libredb-it-kc-reuse).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeycloakAdmin, trustingFetch, type AdminCredentials } from "../../../src/adapters/keycloak-admin";
import { embeddedRelease } from "../../../src/cli/release";
import { loadConfig } from "../../../src/config/load";
import { desiredKeycloak, type Account } from "../../../src/keycloak/desired";
import { lookupAdminCredentials } from "../../../src/keycloak/external";
import { KeycloakConvergeError, planKeycloak, type KeycloakAction } from "../../../src/keycloak/planner";
import { idFromLocation } from "../../../src/keycloak/requests";
import { Redactor } from "../../../src/log/redact";
import { computeDesired } from "../../../src/model/desired";
import { PreflightError } from "../../../src/preflight/docker-checks";
import { checkExternalKeycloak, keycloakExpectations } from "../../../src/preflight/external-keycloak";
import { generateSecret } from "../../../src/secrets/generate";
import { emptyState } from "../../../src/state/store";
import { applyKeycloak, observeKeycloak, type ConfigureTarget } from "../../../src/steps/keycloak-configure";
import { observeExternalKeycloakAt } from "../../../src/steps/preflight-external";
import { createCa } from "../../../src/tls/ca";
import { issueLeaf } from "../../../src/tls/leaf";

const PREFIX = `${process.env.LIBREDB_IT_PREFIX ?? "libredb-it-kc"}-reuse`;
const PORT = Number(process.env.LIBREDB_IT_KEYCLOAK_PORT ?? "18080");
const KEYCLOAK = `${PREFIX}-keycloak`;
const BASE_URL = `https://127.0.0.1:${PORT}`;
const LONG = 10 * 60_000;
const ADMIN_PASSWORD_ENV = "LIBREDB_IT_CORP_ADMIN_PASSWORD";

const packageRoot = join(import.meta.dir, "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), `${PREFIX}-`));
const caFile = join(scratch, "tls", "ca.crt");
const adminPassword = generateSecret();
const redactor = new Redactor();
const release = embeddedRelease();
const clientSecrets = { studio: generateSecret(), platform: generateSecret() };
const passwordFiles: Record<Account, string> = {
  "first-admin": join(scratch, "secrets", "first-admin.txt"),
  "user-manager": join(scratch, "secrets", "user-manager.txt"),
};
const owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
const ALICE = { username: "alice", email: "alice@corp.test", firstName: "Alice", lastName: "Admin", password: generateSecret() };
const CAROL = { username: "carol", email: "carol@corp.test", firstName: "Carol", lastName: "Ops", password: generateSecret() };

/** The installation that reuses `realm` of the customer's Keycloak, with the first admin the configuration asks for. */
function installationFor(realm: string) {
  const config = loadConfig({
    file: join(packageRoot, "test", "fixtures", "configs", "docker.yaml"),
    sets: [
      "keycloak.mode=external",
      `keycloak.realm=${realm}`,
      "keycloak.firstAdmin.enabled=true",
      "endpoints.hosts.auth=127.0.0.1",
      `keycloak.external.baseUrl=${BASE_URL}`,
      "keycloak.external.adminRealm=master",
      "keycloak.external.adminUser=admin",
      `keycloak.external.adminPasswordEnv=${ADMIN_PASSWORD_ENV}`,
      `keycloak.external.caBundleFile=${caFile}`,
    ],
  });
  if (config.keycloak.mode !== "external") throw new Error("the configuration does not reuse an external Keycloak");
  const installation = computeDesired(config, release);
  const desired = desiredKeycloak({
    installation,
    keycloak: config.keycloak,
    clientSecrets,
    passwordLocations: { firstAdmin: passwordFiles["first-admin"], userManager: passwordFiles["user-manager"] },
  });
  return { config, external: config.keycloak.external, installation, desired };
}

const corp = installationFor("corp");
const state = emptyState();
let trusted: typeof fetch;

/** The customer's administrator credential, as the installer reads it from the environment on each run. */
function adminCredentials(): AdminCredentials {
  const lookup = lookupAdminCredentials(corp.external, {
    env: { [ADMIN_PASSWORD_ENV]: adminPassword },
    readFile: () => undefined,
  });
  if ("missing" in lookup) throw new Error(lookup.missing);
  redactor.register(lookup.secret);
  return lookup.credentials;
}

function target(setup = corp): ConfigureTarget {
  return {
    baseUrl: setup.installation.keycloak.adminUrl,
    realm: setup.installation.realm,
    credentials: adminCredentials(),
    desired: setup.desired,
    passwordFiles,
    owner,
    redactor,
    log: () => {},
    fetch: trusted,
  };
}

/** The customer's own administrator in the realm console, who sets the realm up and assigns roles. */
function customer(): KeycloakAdmin {
  return new KeycloakAdmin({ baseUrl: BASE_URL, credentials: adminCredentials(), log: () => {}, fetch: trusted });
}

async function plan(setup = corp): Promise<KeycloakAction[]> {
  return planKeycloak(setup.desired, await observeKeycloak(target(setup), state));
}

async function converge(): Promise<KeycloakAction[]> {
  const actions = await plan();
  await applyKeycloak(actions, target(), state);
  return actions;
}

/** Runs the external Keycloak checks of preflight against realm corp and returns their warnings. */
async function preflight(): Promise<string[]> {
  const observation = await observeExternalKeycloakAt({
    issuer: corp.installation.issuer,
    realm: corp.installation.realm,
    adminUrl: corp.installation.keycloak.adminUrl,
    caBundleFile: corp.external.caBundleFile,
    access: { credentials: adminCredentials() },
    fetch: trusted,
    log: () => {},
  });
  return checkExternalKeycloak(observation, keycloakExpectations(release));
}

function docker(args: readonly string[], check = true): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`docker ${args.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

async function startKeycloak(): Promise<void> {
  const ca = await createCa({ commonName: `${PREFIX} test CA`, now: new Date() });
  const leaf = await issueLeaf(ca, ["127.0.0.1"], new Date());
  const tls = join(scratch, "tls");
  mkdirSync(tls, { mode: 0o755 });
  chmodSync(tls, 0o755);
  writeFileSync(caFile, ca.certPem, { mode: 0o644 });
  writeFileSync(join(tls, "tls.crt"), leaf.certPem, { mode: 0o644 });
  // A throwaway test key, which the keycloak user of the image must read.
  writeFileSync(join(tls, "tls.key"), leaf.keyPem, { mode: 0o644 });
  writeFileSync(join(scratch, "keycloak.env"), `KC_BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}\n`, { mode: 0o600 });
  trusted = trustingFetch([ca.certPem]);
  docker([
    "run",
    "--detach",
    "--name",
    KEYCLOAK,
    "--publish",
    `127.0.0.1:${PORT}:8443`,
    "--volume",
    `${tls}:/etc/libredb-it/tls:ro`,
    "--env-file",
    join(scratch, "keycloak.env"),
    "--env",
    "KC_BOOTSTRAP_ADMIN_USERNAME=admin",
    "--env",
    "KC_HTTPS_CERTIFICATE_FILE=/etc/libredb-it/tls/tls.crt",
    "--env",
    "KC_HTTPS_CERTIFICATE_KEY_FILE=/etc/libredb-it/tls/tls.key",
    "--env",
    `KC_HOSTNAME=${BASE_URL}`,
    corp.installation.images.keycloak,
    "start-dev",
  ]);
  const deadline = Date.now() + 300_000;
  for (;;) {
    const status = await trusted(`${BASE_URL}/realms/master`).then(
      (response) => response.status,
      () => 0,
    );
    if (status === 200) return;
    if (Date.now() > deadline) throw new Error(`${KEYCLOAK} did not answer on ${BASE_URL} within 300 s`);
    await Bun.sleep(1000);
  }
}

async function createUser(realm: string, user: typeof ALICE): Promise<string> {
  const created = await customer().write(
    "POST",
    `/admin/realms/${realm}/users`,
    {
      username: user.username,
      email: user.email,
      emailVerified: true,
      firstName: user.firstName,
      lastName: user.lastName,
      enabled: true,
      credentials: [{ type: "password", value: user.password, temporary: false }],
    },
    [201],
  );
  return idFromLocation(created.location, `user ${user.username}`);
}

async function clientOf(clientId: string, realm = "corp"): Promise<Record<string, unknown> & { id: string }> {
  const [client] = await customer().get<(Record<string, unknown> & { id: string })[]>(
    `/admin/realms/${realm}/clients?clientId=${clientId}`,
  );
  if (client === undefined) throw new Error(`realm ${realm} has no client ${clientId}`);
  return client;
}

interface RoleMappings {
  realmMappings?: { name: string }[];
  clientMappings?: Record<string, { mappings?: { name: string }[] }>;
}

const managementRoles = (mappings: RoleMappings) =>
  (mappings.clientMappings?.["realm-management"]?.mappings ?? []).map((role) => role.name).sort();

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (payload === undefined) throw new Error("not a compact JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** An authorization-code login with PKCE through the realm's login form, returning the claims of the ID token. */
async function codeLogin(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  user: typeof ALICE,
): Promise<Record<string, unknown>> {
  const oidc = `${corp.installation.issuer}/protocol/openid-connect`;
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const authorize = new URL(`${oidc}/auth`);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
    state: "reuse-test",
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const page = await trusted(authorize, { redirect: "manual" });
  expect(page.status).toBe(200);
  const cookies = page.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0])
    .join("; ");
  const form = /<form\b[^>]*\bid="kc-form-login"[^>]*>/.exec(await page.text())?.[0];
  const action = form === undefined ? undefined : /\baction="([^"]+)"/.exec(form)?.[1]?.replaceAll("&amp;", "&");
  if (action === undefined) throw new Error("the login page has no form kc-form-login with an action");
  const submitted = await trusted(action, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
    body: new URLSearchParams({ username: user.username, password: user.password, credentialId: "" }),
  });
  const location = submitted.headers.get("location") ?? "";
  expect({ status: submitted.status, toRedirectUri: location.startsWith(redirectUri) }).toEqual({ status: 302, toRedirectUri: true });
  const response = await trusted(`${oidc}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(location).searchParams.get("code") ?? "",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  expect(response.status).toBe(200);
  const claims = decodeJwtPayload(((await response.json()) as { id_token: string }).id_token);
  expect(claims.nonce).toBe(nonce);
  return claims;
}

const summaries = (actions: readonly KeycloakAction[]) => actions.map((action) => action.summary);

beforeAll(async () => {
  docker(["rm", "--force", "--volumes", KEYCLOAK], false);
  mkdirSync(join(scratch, "secrets"), { mode: 0o700 });
  await startKeycloak();
  // The customer's realm as its identity team runs it: a realm role admin that means something else, a user holding
  // it, and a user that the team gives libredb:admin once the installer has created the libredb client.
  await customer().write("POST", "/admin/realms", { realm: "corp", enabled: true, displayName: "Corp" }, [201]);
  await customer().write(
    "POST",
    "/admin/realms/corp/roles",
    { name: "admin", description: "Corp IT administrators", attributes: { team: ["it-operations"] } },
    [201],
  );
  await createUser("corp", ALICE);
  const carol = await createUser("corp", CAROL);
  const realmAdmin = await customer().get<{ id: string; name: string }>("/admin/realms/corp/roles/admin");
  await customer().write("POST", `/admin/realms/corp/users/${carol}/role-mappings/realm`, [realmAdmin], [204]);
}, LONG);

afterAll(() => {
  docker(["rm", "--force", "--volumes", KEYCLOAK], false);
  rmSync(scratch, { recursive: true, force: true });
});

describe("keycloak reuse", () => {
  test(
    "in realm corp with an unrelated realm role admin, converge creates client libredb with roles admin and user, leaves the realm role untouched, and the ID token carries libredb_roles",
    async () => {
      const realmBefore = await customer().get<Record<string, unknown>>("/admin/realms/corp");
      const roleBefore = await customer().get<Record<string, unknown>>("/admin/realms/corp/roles/admin");
      expect(await preflight()).toEqual([]);

      const actions = await converge();
      expect(summaries(actions).slice(0, 3)).toEqual([
        "create client libredb",
        "create role admin on client libredb",
        "create role user on client libredb",
      ]);
      const libredb = await clientOf("libredb");
      expect((libredb.attributes as Record<string, string>)["libredb.managed"]).toBe("true");
      const roles = await customer().get<{ name: string }[]>(`/admin/realms/corp/clients/${libredb.id}/roles`);
      expect(roles.map((role) => role.name).sort()).toEqual(["admin", "user"]);
      // The realm role and the realm's settings stay as the customer left them, and no installer client exists.
      expect(await customer().get<Record<string, unknown>>("/admin/realms/corp/roles/admin")).toEqual(roleBefore);
      expect(await customer().get<Record<string, unknown>>("/admin/realms/corp")).toEqual(realmBefore);
      expect(await customer().get<unknown[]>("/admin/realms/corp/clients?clientId=libredb-installer")).toEqual([]);

      // The identity team gives alice libredb:admin; carol keeps only the customer's realm role admin.
      const [alice] = await customer().get<{ id: string }[]>("/admin/realms/corp/users?username=alice&exact=true");
      if (alice === undefined) throw new Error("realm corp has no user alice");
      const adminRole = await customer().get<{ id: string; name: string }>(`/admin/realms/corp/clients/${libredb.id}/roles/admin`);
      await customer().write("POST", `/admin/realms/corp/users/${alice.id}/role-mappings/clients/${libredb.id}`, [adminRole], [204]);

      const clients = corp.installation.clients;
      for (const login of [
        { clientId: "libredb-studio", secret: clientSecrets.studio, redirectUri: clients.studio.redirectUri },
        { clientId: "libredb-platform", secret: clientSecrets.platform, redirectUri: clients.platform.redirectUri },
      ]) {
        const claims = await codeLogin(login.clientId, login.secret, login.redirectUri, ALICE);
        expect({ client: login.clientId, iss: claims.iss, email: claims.email, libredb_roles: claims.libredb_roles }).toEqual({
          client: login.clientId,
          iss: corp.installation.issuer,
          email: ALICE.email,
          libredb_roles: ["admin"],
        });
      }
      const carol = await codeLogin("libredb-studio", clientSecrets.studio, clients.studio.redirectUri, CAROL);
      expect({ email: carol.email, libredb_roles: carol.libredb_roles }).toEqual({ email: CAROL.email, libredb_roles: undefined });

      expect(await plan()).toEqual([]);
    },
    LONG,
  );

  test(
    "a pairwise subject mapper on libredb-studio fails preflight with exit 3 naming the client",
    async () => {
      const studio = await clientOf("libredb-studio");
      const added = await customer().write(
        "POST",
        `/admin/realms/corp/clients/${studio.id}/protocol-mappers/models`,
        {
          name: "pairwise subject",
          protocol: "openid-connect",
          protocolMapper: "oidc-sha256-pairwise-sub-mapper",
          config: { sectorIdentifierUri: "", pairwiseSubAlgorithmSalt: "" },
        },
        [201],
      );
      const error = await preflight().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PreflightError);
      expect((error as PreflightError).exitCode).toBe(3);
      expect((error as PreflightError).problems).toEqual([
        "client libredb-studio has the mapper pairwise subject of type oidc-sha256-pairwise-sub-mapper, which would " +
          "change the sub claim that Studio and Platform key every user by; remove the mapper",
      ]);
      await customer().write(
        "DELETE",
        `/admin/realms/corp/clients/${studio.id}/protocol-mappers/models/${idFromLocation(added.location, "mapper")}`,
        undefined,
        [204],
      );
      expect(await preflight()).toEqual([]);
    },
    LONG,
  );

  test(
    "an unmarked client named libredb-platform is refused with exit 6",
    async () => {
      // Realm sales already has a client of the installer's name that its own team made.
      await customer().write("POST", "/admin/realms", { realm: "sales", enabled: true }, [201]);
      await customer().write(
        "POST",
        "/admin/realms/sales/clients",
        { clientId: "libredb-platform", publicClient: false, standardFlowEnabled: true, redirectUris: ["https://bi.sales.test/*"] },
        [201],
      );
      const before = await clientOf("libredb-platform", "sales");
      const error = await plan(installationFor("sales")).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(KeycloakConvergeError);
      expect((error as KeycloakConvergeError).exitCode).toBe(6);
      expect((error as KeycloakConvergeError).message).toContain("realm sales holds client libredb-platform");
      expect(await clientOf("libredb-platform", "sales")).toEqual(before);
    },
    LONG,
  );

  test(
    "converge in realm corp assigns no realm-management role to any user",
    async () => {
      // Service accounts are not users of the realm's user list; libredb-platform's is checked below.
      const users = await customer().get<{ id: string; username: string }[]>("/admin/realms/corp/users?max=1000");
      expect(users.map((user) => user.username).sort()).toEqual(["alice", "carol", "libredb-admin"]);
      for (const user of users) {
        const mappings = await customer().get<RoleMappings>(`/admin/realms/corp/users/${user.id}/role-mappings`);
        expect({ user: user.username, realmManagement: managementRoles(mappings) }).toEqual({
          user: user.username,
          realmManagement: [],
        });
      }
      const [firstAdmin] = users.filter((user) => user.username === "libredb-admin");
      if (firstAdmin === undefined) throw new Error("the converge created no first admin");
      const held = await customer().get<RoleMappings>(`/admin/realms/corp/users/${firstAdmin.id}/role-mappings`);
      expect((held.clientMappings?.libredb?.mappings ?? []).map((role) => role.name)).toEqual(["admin"]);

      // The service account of libredb-platform reads the directory with view-users and view-clients alone.
      const platform = await clientOf("libredb-platform");
      const account = await customer().get<{ id: string }>(`/admin/realms/corp/clients/${platform.id}/service-account-user`);
      const accountRoles = await customer().get<RoleMappings>(`/admin/realms/corp/users/${account.id}/role-mappings`);
      expect(managementRoles(accountRoles)).toEqual(["view-clients", "view-users"]);
    },
    LONG,
  );
});
