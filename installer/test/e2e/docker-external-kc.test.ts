// Docker mode against the customer's own Keycloak end to end. A stand-in for it runs from the pinned Keycloak image
// with TLS from a test CA at https://auth.libredb.test:<port>, holding realm corp with a realm role admin of its own and
// a provisioning client that has realm-admin there. The compiled installer applies the whole installation as root under
// /opt/libredb and reuses realm corp through the Admin API with that client's secret from its environment. Then the
// site's identity team gives people of realm corp libredb:admin and manage-users, and verify's warning check admin-mfa
// names each one without an OTP credential.
// It needs a disposable Linux host with Docker whose /etc/hosts maps auth.libredb.test to 127.0.0.1, because it removes
// any earlier install first, and it removes its own install and the stand-in when it ends.
// LIBREDB_E2E_EXTERNAL_KEYCLOAK_PORT sets the port the stand-in serves on, inside its container and on the host's
// loopback interface alike (default 8443). LIBREDB_INSTALLER_BIN names another installer binary than
// dist/libredb-installer-linux-x64, and LIBREDB_E2E_IMAGES_REGISTRY sets images.registry for every run, which the
// stand-in's image comes from as well, such as registry.example.com/libredb for images in a registry mirror.
// The last tests replace that install with one against realm site of the same stand-in, which the customer's
// administrator configures from the installer's export and which the installer reaches with the two client secrets only
// (keycloak.external.provisioning manual).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { KeycloakAdmin, trustingFetch } from "../../src/adapters/keycloak-admin";
import type { KeycloakExport } from "../../src/keycloak/export";
import { embeddedRelease } from "../../src/cli/release";
import { idFromLocation } from "../../src/keycloak/requests";
import { imageReference } from "../../src/release/images";
import { generateSecret } from "../../src/secrets/generate";
import { createCa } from "../../src/tls/ca";
import { parseCertificates } from "../../src/tls/inspect";
import { issueLeaf } from "../../src/tls/leaf";
import { CATALOGUE } from "../../src/verify/catalogue";
import { applyExport, grantsServiceAccountRoles } from "../fixtures/keycloak/apply-export";
import { LICENSE_ARGS } from "./support/install";

const packageRoot = join(import.meta.dir, "..", "..");
const INSTALLER = process.env.LIBREDB_INSTALLER_BIN ?? join(packageRoot, "dist", "libredb-installer-linux-x64");
const CONFIG = join(packageRoot, "test", "fixtures", "configs", "docker-external-kc.yaml");
const MANUAL_CONFIG = join(packageRoot, "test", "fixtures", "configs", "docker-external-kc-manual.yaml");
const REGISTRY = process.env.LIBREDB_E2E_IMAGES_REGISTRY;
const PORT = Number(process.env.LIBREDB_E2E_EXTERNAL_KEYCLOAK_PORT ?? "8443");
const AUTH_HOST = "auth.libredb.test";
const BASE_URL = `https://${AUTH_HOST}:${PORT}`;
const ISSUER = `${BASE_URL}/realms/corp`;
const STAND_IN = "libredb-e2e-corp-keycloak";
const SECRET_ENV = "LIBREDB_E2E_CORP_ADMIN_SECRET";
const INSTALL_ROOT = "/opt/libredb";
const PROJECT = "libredb";
const EDGE_NETWORK = `${PROJECT}_edge`;
const CA_BUNDLE = join(INSTALL_ROOT, "ca", "ca.crt");
const LONG = 20 * 60_000;

const scratch = mkdtempSync(join(tmpdir(), "libredb-e2e-corp-"));
const corpCaFile = join(scratch, "corp-ca.crt");
const registry = REGISTRY === undefined || REGISTRY === "" ? undefined : REGISTRY;
const CONFIG_ARGS = [
  "-c",
  CONFIG,
  "--set",
  `keycloak.external.baseUrl=${BASE_URL}`,
  "--set",
  `keycloak.external.caBundleFile=${corpCaFile}`,
  ...(registry === undefined ? [] : ["--set", `images.registry=${registry}`]),
  ...LICENSE_ARGS,
];
const studioSecretFile = join(scratch, "site-studio-client-secret");
const platformSecretFile = join(scratch, "site-platform-client-secret");
const MANUAL_ARGS = [
  "-c",
  MANUAL_CONFIG,
  "--set",
  `keycloak.external.baseUrl=${BASE_URL}`,
  "--set",
  `keycloak.external.caBundleFile=${corpCaFile}`,
  "--set",
  `keycloak.external.studioClientSecretFile=${studioSecretFile}`,
  "--set",
  `keycloak.external.platformClientSecretFile=${platformSecretFile}`,
  ...(registry === undefined ? [] : ["--set", `images.registry=${registry}`]),
  ...LICENSE_ARGS,
];
// The customer's secrets: the stand-in's bootstrap administrator, and the provisioning client the installer uses.
const bootstrapPassword = generateSecret();
const provisionerSecret = generateSecret();

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Report {
  checks: { id: string; result: string; cause: string | null }[];
}

// Everything the installer printed during this file, which must never hold the customer's secret.
const printed: string[] = [];
let trusted: typeof fetch;
let corpCaPem: string;

function sh(argv: string[], check = true): RunResult {
  const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`${argv.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

/** Runs the installer with stdin on /dev/null, with the customer's secret in its environment unless `withSecret` is false. */
async function installer(withSecret: boolean, ...args: string[]): Promise<RunResult> {
  const env: Record<string, string | undefined> = { ...process.env, [SECRET_ENV]: withSecret ? provisionerSecret : undefined };
  const child = Bun.spawn([INSTALLER, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  printed.push(stdout, stderr);
  return { code, stdout, stderr };
}

const failedChecks = (report: Report) => report.checks.filter((check) => check.result === "failed");

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

/** Removes the LibreDB install and its networks, and keeps the stand-in, which leaves the edge network first. */
function removeLibreDB(): void {
  sh(["docker", "network", "disconnect", "--force", EDGE_NETWORK, STAND_IN], false);
  const label = `label=com.docker.compose.project=${PROJECT}`;
  const ids = (kind: string[]) => sh([...kind, "--filter", label, "--quiet"]).stdout.split("\n").filter(Boolean);
  const containerIdsFound = ids(["docker", "ps", "--all"]);
  if (containerIdsFound.length > 0) sh(["docker", "rm", "--force", "--volumes", ...containerIdsFound]);
  const networks = ids(["docker", "network", "ls"]);
  if (networks.length > 0) sh(["docker", "network", "rm", ...networks]);
  const volumes = ids(["docker", "volume", "ls"]);
  if (volumes.length > 0) sh(["docker", "volume", "rm", "--force", ...volumes]);
  rmSync(INSTALL_ROOT, { recursive: true, force: true });
}

function removeInstall(): void {
  sh(["docker", "rm", "--force", "--volumes", STAND_IN], false);
  removeLibreDB();
}

/** The customer's administrator of realm master, who sets realm corp up as the site's identity team runs it. */
function customer(): KeycloakAdmin {
  return new KeycloakAdmin({
    baseUrl: BASE_URL,
    credentials: { realm: "master", clientId: "admin-cli", username: "admin", password: bootstrapPassword },
    log: () => {},
    fetch: trusted,
  });
}

/** Starts the stand-in for the customer's Keycloak, with TLS for auth.libredb.test from a CA of its own. */
async function startStandIn(): Promise<void> {
  const ca = await createCa({ commonName: "Corp test CA", now: new Date() });
  const leaf = await issueLeaf(ca, [AUTH_HOST], new Date());
  corpCaPem = ca.certPem;
  writeFileSync(corpCaFile, ca.certPem, { mode: 0o644 });
  const tls = join(scratch, "tls");
  mkdirSync(tls, { mode: 0o755 });
  chmodSync(tls, 0o755);
  writeFileSync(join(tls, "tls.crt"), leaf.certPem, { mode: 0o644 });
  // A throwaway test key, which the keycloak user of the image must read.
  writeFileSync(join(tls, "tls.key"), leaf.keyPem, { mode: 0o644 });
  writeFileSync(join(scratch, "keycloak.env"), `KC_BOOTSTRAP_ADMIN_PASSWORD=${bootstrapPassword}\n`, { mode: 0o600 });
  trusted = trustingFetch([ca.certPem]);
  sh([
    "docker",
    "run",
    "--detach",
    "--name",
    STAND_IN,
    "--publish",
    `127.0.0.1:${PORT}:${PORT}`,
    "--volume",
    `${tls}:/etc/corp-tls:ro`,
    "--env-file",
    join(scratch, "keycloak.env"),
    "--env",
    "KC_BOOTSTRAP_ADMIN_USERNAME=admin",
    "--env",
    `KC_HTTPS_PORT=${PORT}`,
    "--env",
    "KC_HTTPS_CERTIFICATE_FILE=/etc/corp-tls/tls.crt",
    "--env",
    "KC_HTTPS_CERTIFICATE_KEY_FILE=/etc/corp-tls/tls.key",
    "--env",
    `KC_HOSTNAME=${BASE_URL}`,
    imageReference(embeddedRelease().images.keycloak, registry),
    "start-dev",
  ]);
  const deadline = Date.now() + 300_000;
  for (;;) {
    const status = await trusted(`${BASE_URL}/realms/master`).then(
      (response) => response.status,
      () => 0,
    );
    if (status === 200) break;
    if (Date.now() > deadline) throw new Error(`${STAND_IN} did not answer on ${BASE_URL} within 300 s`);
    await Bun.sleep(2_000);
  }
  // Realm corp, with a realm role admin that means something else at the site, and the provisioning client.
  await customer().write("POST", "/admin/realms", { realm: "corp", enabled: true }, [201]);
  await customer().write("POST", "/admin/realms/corp/roles", { name: "admin", description: "Corp IT administrators" }, [201]);
  const created = await customer().write(
    "POST",
    "/admin/realms/corp/clients",
    {
      clientId: "corp-provisioner",
      secret: provisionerSecret,
      publicClient: false,
      standardFlowEnabled: false,
      serviceAccountsEnabled: true,
    },
    [201],
  );
  const provisioner = idFromLocation(created.location, "client corp-provisioner");
  const [management] = await customer().get<{ id: string }[]>("/admin/realms/corp/clients?clientId=realm-management");
  if (management === undefined) throw new Error("realm corp has no realm-management client");
  const realmAdmin = await customer().get<{ id: string; name: string }>(
    `/admin/realms/corp/clients/${management.id}/roles/realm-admin`,
  );
  const account = await customer().get<{ id: string }>(`/admin/realms/corp/clients/${provisioner}/service-account-user`);
  await customer().write(
    "POST",
    `/admin/realms/corp/users/${account.id}/role-mappings/clients/${management.id}`,
    [realmAdmin],
    [204],
  );
}

beforeAll(async () => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("the Docker end-to-end tests need root on a disposable Linux host with Docker");
  }
  if (!existsSync(INSTALLER)) throw new Error(`${INSTALLER} does not exist; run bun run build first`);
  removeInstall();
  await startStandIn();
}, LONG);

afterAll(() => {
  removeInstall();
  rmSync(scratch, { recursive: true, force: true });
});

describe("Docker mode with an external Keycloak", () => {
  test(
    "an install against an external Keycloak converges twice and passes verify",
    async () => {
      // The installation's networks come first, so that the stand-in joins the edge network under its public name, as
      // the site's DNS lets the containers reach the customer's Keycloak.
      const base = await installer(true, "apply", ...CONFIG_ARGS, "--only", "preflight,images,secrets,tls,base", "--yes");
      expect({ code: base.code, stderr: base.stderr }).toEqual({ code: 0, stderr: "" });
      sh(["docker", "network", "connect", "--alias", AUTH_HOST, EDGE_NETWORK, STAND_IN]);

      const first = await installer(true, "apply", ...CONFIG_ARGS, "--yes");
      expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: "" });
      expect(first.stdout).toContain("keycloak-configure: create client libredb\n");
      expect(first.stdout).toContain("LibreDB is installed and every verify check passed.");
      expect(first.stdout).toContain(`  Auth      ${BASE_URL}`);
      // The customer's identity team manages the realm's users, so the installer created no account.
      expect(first.stdout).not.toContain("first-admin.txt");
      expect(first.stdout).not.toContain("keycloak-configure: create user");

      const second = await installer(true, "apply", ...CONFIG_ARGS, "--yes");
      expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: "" });
      expect(second.stdout).toStartWith("No changes\n");
      expect(second.stdout).toContain("LibreDB is installed and every verify check passed.");

      const verify = await installer(false, "verify", ...CONFIG_ARGS, "--output", "json");
      const report = JSON.parse(verify.stdout) as Report;
      expect(report.checks.map((check) => check.id)).toEqual(CATALOGUE.map((check) => check.id));
      expect(failedChecks(report)).toEqual([]);
      expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });

      // Both apps trust the customer issuer through the CA bundle, and Platform derives the Admin API URL from it.
      const bundle = parseCertificates(readFileSync(CA_BUNDLE, "utf8"), CA_BUNDLE).map((cert) => cert.fingerprint256);
      expect(bundle).toContain(parseCertificates(corpCaPem, "the corp CA")[0]?.fingerprint256);
      const platformEnv = readFileSync(join(INSTALL_ROOT, "env", "platform.env"), "utf8");
      expect(platformEnv).toContain(`AUTH_KEYCLOAK_ISSUER=${ISSUER}\n`);
      expect(platformEnv).not.toContain("KEYCLOAK_ADMIN_URL");
      expect(readFileSync(join(INSTALL_ROOT, "env", "studio.env"), "utf8")).toContain(`OIDC_ISSUER=${ISSUER}\n`);
      const compose = parse(readFileSync(join(INSTALL_ROOT, "compose.yaml"), "utf8")) as { services: Record<string, unknown> };
      expect(Object.keys(compose.services)).not.toContain("keycloak");
      expect(existsSync(join(INSTALL_ROOT, "secrets", "installer.env"))).toBe(false);

      // No libredb-installer client, and the realm-management roles stay with the provisioning client and Platform.
      expect(await customer().get<unknown[]>("/admin/realms/corp/clients?clientId=libredb-installer")).toEqual([]);
      const [libredb] = await customer().get<{ id: string }[]>("/admin/realms/corp/clients?clientId=libredb");
      if (libredb === undefined) throw new Error("realm corp has no client libredb");
      const roles = await customer().get<{ name: string }[]>(`/admin/realms/corp/clients/${libredb.id}/roles`);
      expect(roles.map((role) => role.name).sort()).toEqual(["admin", "user"]);
      expect((await customer().get<{ description?: string }>("/admin/realms/corp/roles/admin")).description).toBe(
        "Corp IT administrators",
      );
    },
    LONG,
  );

  test(
    "an apply without the admin credential skips the Keycloak checks and the converge with a note and changes nothing",
    async () => {
      const unattended = await installer(false, "apply", ...CONFIG_ARGS, "--yes");
      expect({ code: unattended.code, stderr: unattended.stderr }).toEqual({ code: 0, stderr: "" });
      expect(unattended.stdout).toStartWith("No changes\n");
      expect(unattended.stdout).toContain("LibreDB is installed and every verify check passed.");
      expect(unattended.stdout).toContain(`keycloak.external.adminClientSecretEnv names ${SECRET_ENV}, which is not set`);
    },
    LONG,
  );

  test(
    "admin-mfa warns naming each person of realm corp who holds libredb:admin or manage-users without an OTP credential",
    async () => {
      // The identity team gives people the roles: libredb:admin directly and through a subgroup of a group that holds it,
      // manage-users of realm-management, and libredb:admin to one person with a TOTP device.
      const corp = customer();
      const clientUuid = async (clientId: string) => {
        const [client] = await corp.get<{ id: string }[]>(`/admin/realms/corp/clients?clientId=${clientId}`);
        if (client === undefined) throw new Error(`realm corp has no client ${clientId}`);
        return client.id;
      };
      const libredb = await clientUuid("libredb");
      const management = await clientUuid("realm-management");
      const admin = await corp.get<{ id: string; name: string }>(`/admin/realms/corp/clients/${libredb}/roles/admin`);
      const manageUsers = await corp.get<{ id: string; name: string }>(
        `/admin/realms/corp/clients/${management}/roles/manage-users`,
      );
      const createUser = async (username: string, credentials: unknown[] = []) => {
        const created = await corp.write("POST", "/admin/realms/corp/users", { username, enabled: true, credentials }, [201]);
        return idFromLocation(created.location, `user ${username}`);
      };
      const createGroup = async (path: string, name: string) => {
        const created = await corp.write("POST", path, { name }, [201]);
        return idFromLocation(created.location, `group ${name}`);
      };

      const direct = await createUser("corp-direct-admin");
      await corp.write("POST", `/admin/realms/corp/users/${direct}/role-mappings/clients/${libredb}`, [admin], [204]);
      const dbas = await createGroup("/admin/realms/corp/groups", "corp-dbas");
      await corp.write("POST", `/admin/realms/corp/groups/${dbas}/role-mappings/clients/${libredb}`, [admin], [204]);
      const onCall = await createGroup(`/admin/realms/corp/groups/${dbas}/children`, "on-call");
      const grouped = await createUser("corp-group-admin");
      await corp.write("PUT", `/admin/realms/corp/users/${grouped}/groups/${onCall}`, undefined, [204]);
      const manager = await createUser("corp-user-manager");
      await corp.write("POST", `/admin/realms/corp/users/${manager}/role-mappings/clients/${management}`, [manageUsers], [204]);
      // A TOTP device as Keycloak stores one when the required action CONFIGURE_TOTP completes.
      const totp = {
        type: "otp",
        userLabel: "Corp phone",
        secretData: JSON.stringify({ value: generateSecret() }),
        credentialData: JSON.stringify({ subType: "totp", digits: 6, counter: 0, period: 30, algorithm: "HmacSHA1" }),
      };
      const secured = await createUser("corp-otp-admin", [totp]);
      await corp.write("POST", `/admin/realms/corp/users/${secured}/role-mappings/clients/${libredb}`, [admin], [204]);
      const credentials = await corp.get<{ type: string }[]>(`/admin/realms/corp/users/${secured}/credentials`);
      expect(credentials.map((credential) => credential.type)).toEqual(["otp"]);

      // verify reads the holders as the libredb-platform service account and needs no admin credential.
      const verify = await installer(false, "verify", ...CONFIG_ARGS, "--output", "json");
      const report = JSON.parse(verify.stdout) as Report;
      expect(failedChecks(report)).toEqual([]);
      const mfa = report.checks.find((check) => check.id === "admin-mfa");
      expect(mfa).toEqual({
        id: "admin-mfa",
        result: "warning",
        cause:
          "3 accounts hold libredb:admin or manage-users without an OTP credential, and every governance install requires " +
          "Keycloak MFA for them: corp-direct-admin (libredb:admin), corp-group-admin (libredb:admin), corp-user-manager " +
          "(realm-management manage-users)",
      });
      // The holder with a TOTP device is not named, and neither is the provisioning client's service account.
      expect(mfa?.cause).not.toContain("corp-otp-admin");
      expect(mfa?.cause).not.toContain("service-account-");
      expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });
    },
    LONG,
  );

  test(
    "the customer's secret appears nowhere under /opt/libredb and in nothing the installer printed",
    () => {
      const holding = filesUnder(INSTALL_ROOT).filter((file) => readFileSync(file, "latin1").includes(provisionerSecret));
      expect(holding).toEqual([]);
      expect(sh(["grep", "-rF", provisionerSecret, INSTALL_ROOT], false).code).toBe(1);
      expect(printed.filter((text) => text.includes(provisionerSecret))).toEqual([]);
    },
    LONG,
  );
});

describe("Docker mode with a realm the site configures from the export", () => {
  // The customer's administrator of realm master configures realm site from the export and shares the client secrets.
  test(
    "an install with provisioning manual against a hand-configured realm converges twice and passes verify",
    async () => {
      removeLibreDB();
      const out = join(scratch, "export");
      const written = await installer(false, "keycloak", "export", ...MANUAL_ARGS, "--output", out);
      expect({ code: written.code, stderr: written.stderr }).toEqual({ code: 0, stderr: "" });
      const exported = JSON.parse(readFileSync(join(out, "libredb-keycloak-export.json"), "utf8")) as KeycloakExport;
      expect(exported.issuer).toBe(`${BASE_URL}/realms/site`);

      await customer().write("POST", "/admin/realms", { realm: "site", enabled: true }, [201]);
      await applyExport(customer(), exported, (request) => !grantsServiceAccountRoles(request));
      // The identity team assigns the service account roles of libredb-platform by hand, in the console.
      const clientUuid = async (clientId: string) => {
        const [client] = await customer().get<{ id: string }[]>(`/admin/realms/site/clients?clientId=${clientId}`);
        if (client === undefined) throw new Error(`realm site has no client ${clientId}`);
        return client.id;
      };
      const management = await clientUuid("realm-management");
      const roles = [];
      for (const role of ["view-users", "view-clients"]) {
        roles.push(await customer().get<{ id: string; name: string }>(`/admin/realms/site/clients/${management}/roles/${role}`));
      }
      const account = await customer().get<{ id: string }>(
        `/admin/realms/site/clients/${await clientUuid("libredb-platform")}/service-account-user`,
      );
      await customer().write("POST", `/admin/realms/site/users/${account.id}/role-mappings/clients/${management}`, roles, [204]);
      const secrets: string[] = [];
      for (const [clientId, file] of [["libredb-studio", studioSecretFile], ["libredb-platform", platformSecretFile]] as const) {
        const { value } = await customer().get<{ value: string }>(`/admin/realms/site/clients/${await clientUuid(clientId)}/client-secret`);
        writeFileSync(file, `${value}\n`, { mode: 0o600 });
        secrets.push(value);
      }

      const base = await installer(false, "apply", ...MANUAL_ARGS, "--only", "preflight,images,secrets,tls,base", "--yes");
      expect({ code: base.code, stderr: base.stderr }).toEqual({ code: 0, stderr: "" });
      sh(["docker", "network", "connect", "--alias", AUTH_HOST, EDGE_NETWORK, STAND_IN]);

      const first = await installer(false, "apply", ...MANUAL_ARGS, "--yes");
      expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: "" });
      expect(first.stdout).not.toContain("keycloak-configure:");
      expect(first.stdout).toContain("LibreDB is installed and every verify check passed.");

      const second = await installer(false, "apply", ...MANUAL_ARGS, "--yes");
      expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: "" });
      expect(second.stdout).toStartWith("No changes\n");
      expect(second.stdout).toContain("LibreDB is installed and every verify check passed.");

      const verify = await installer(false, "verify", ...MANUAL_ARGS, "--output", "json");
      const report = JSON.parse(verify.stdout) as Report;
      expect(failedChecks(report)).toEqual([]);
      expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });

      // Both apps run with the secrets Keycloak generated, and the installer created nothing in realm site.
      expect(readFileSync(join(INSTALL_ROOT, "env", "studio.env"), "utf8")).toContain(secrets[0] as string);
      expect(readFileSync(join(INSTALL_ROOT, "env", "platform.env"), "utf8")).toContain(secrets[1] as string);
      expect(await customer().get<unknown[]>("/admin/realms/site/clients?clientId=libredb-installer")).toEqual([]);

      // A realm the site breaks later is refused with exit 3, naming what to fix, and the install is left as it was.
      await customer().write("DELETE", `/admin/realms/site/users/${account.id}/role-mappings/clients/${management}`, roles.slice(0, 1), [204]);
      const refused = await installer(false, "apply", ...MANUAL_ARGS, "--yes");
      expect(refused.code).toBe(3);
      expect(refused.stderr).toContain("give it the realm-management role view-users");
      await customer().write("POST", `/admin/realms/site/users/${account.id}/role-mappings/clients/${management}`, roles.slice(0, 1), [204]);
    },
    LONG,
  );

  test(
    "no Keycloak admin credential appears in the config, the state or the logs of the manual install",
    async () => {
      const normalized = await installer(false, "validate", ...MANUAL_ARGS);
      expect(normalized.code).toBe(0);
      expect(normalized.stdout).not.toMatch(/admin(Realm|ClientId|ClientSecret|User|Password)/);
      const state = readFileSync(join(INSTALL_ROOT, "state", "state.json"), "utf8");
      expect(state).not.toMatch(/admin(Realm|ClientId|ClientSecret|User|Password)|corp-provisioner|admin-cli/);
      for (const secret of [bootstrapPassword, provisionerSecret]) {
        expect(filesUnder(INSTALL_ROOT).filter((file) => readFileSync(file, "latin1").includes(secret))).toEqual([]);
        expect(printed.filter((text) => text.includes(secret))).toEqual([]);
      }
      const logs = filesUnder(join(INSTALL_ROOT, "logs")).map((file) => readFileSync(file, "utf8")).join("\n");
      expect(logs).not.toMatch(/admin-cli|corp-provisioner|\/realms\/master\//);
    },
    LONG,
  );
});
