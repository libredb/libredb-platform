// A realm that the site's identity team configures itself from the installer's export
// (keycloak.external.provisioning manual): the customer's Keycloak runs from the pinned Keycloak image in dev mode
// with TLS from a test CA, its administrator applies the export to the empty realm site and assigns the service account
// roles of libredb-platform by hand, and the keycloak-configure step's own manual check then reads the realm with the
// two client secrets only, without any Keycloak admin credential.
// Keycloak's HTTPS port is published on 127.0.0.1:LIBREDB_IT_KEYCLOAK_PORT (default 18080). LIBREDB_IT_PREFIX names the
// container and the scratch directory together with the infix -manual (default libredb-it-kc-manual).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeycloakAdmin, trustingFetch } from "../../../src/adapters/keycloak-admin";
import { embeddedRelease } from "../../../src/cli/release";
import { ExitCode } from "../../../src/cli/exit-codes";
import { loadConfig } from "../../../src/config/load";
import { desiredKeycloak } from "../../../src/keycloak/desired";
import { keycloakExport, type KeycloakExport } from "../../../src/keycloak/export";
import { computeDesired } from "../../../src/model/desired";
import { checkManualKeycloak, manualExpectations, ManualKeycloakError } from "../../../src/preflight/keycloak-manual";
import { generateSecret } from "../../../src/secrets/generate";
import { observeManualKeycloak } from "../../../src/steps/keycloak-configure";
import { createCa } from "../../../src/tls/ca";
import { issueLeaf } from "../../../src/tls/leaf";
import { applyExport, grantsServiceAccountRoles } from "../../fixtures/keycloak/apply-export";

const PREFIX = `${process.env.LIBREDB_IT_PREFIX ?? "libredb-it-kc"}-manual`;
const PORT = Number(process.env.LIBREDB_IT_KEYCLOAK_PORT ?? "18080");
const KEYCLOAK = `${PREFIX}-keycloak`;
const BASE_URL = `https://127.0.0.1:${PORT}`;
const REALM = "site";
const LONG = 10 * 60_000;

const packageRoot = join(import.meta.dir, "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), `${PREFIX}-`));
const caFile = join(scratch, "tls", "ca.crt");
const adminPassword = generateSecret();
const release = embeddedRelease();

// The installation with provisioning manual: the two client secret references and no admin credential.
const config = loadConfig({
  file: join(packageRoot, "test", "fixtures", "configs", "docker.yaml"),
  sets: [
    "keycloak.mode=external",
    `keycloak.realm=${REALM}`,
    "endpoints.hosts.auth=127.0.0.1",
    `keycloak.external.baseUrl=${BASE_URL}`,
    "keycloak.external.provisioning=manual",
    "keycloak.external.studioClientSecretEnv=SITE_STUDIO_CLIENT_SECRET",
    "keycloak.external.platformClientSecretEnv=SITE_PLATFORM_CLIENT_SECRET",
    `keycloak.external.caBundleFile=${caFile}`,
    "mobile.enabled=true",
  ],
});
if (config.keycloak.mode !== "external") throw new Error("the configuration does not reuse an external Keycloak");
const installation = computeDesired(config, release);
const expected = manualExpectations(
  desiredKeycloak({
    installation,
    keycloak: config.keycloak,
    clientSecrets: undefined,
    passwordLocations: { firstAdmin: "", userManager: "" },
  }),
  installation.issuer,
);

let trusted: typeof fetch;
let exported: KeycloakExport;
/** The secrets Keycloak generated for the app clients, which the site shares with the installer. */
const shared = { studio: "", platform: "" };

function docker(args: readonly string[], check = true): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`docker ${args.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

/** The site's administrator of realm master, who configures realm site in the console. */
function customer(): KeycloakAdmin {
  return new KeycloakAdmin({
    baseUrl: BASE_URL,
    credentials: { realm: "master", clientId: "admin-cli", username: "admin", password: adminPassword },
    log: () => {},
    fetch: trusted,
  });
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
    installation.images.keycloak,
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

const base = `/admin/realms/${REALM}`;

async function clientId(id: string): Promise<string> {
  const [client] = await customer().get<{ id: string }[]>(`${base}/clients?clientId=${id}`);
  if (client === undefined) throw new Error(`realm ${REALM} has no client ${id}`);
  return client.id;
}

/** The service account roles of libredb-platform, which the identity team assigns or removes by hand. */
async function serviceAccountRoles(method: "POST" | "DELETE", roles: readonly string[]): Promise<void> {
  const management = await clientId("realm-management");
  const account = await customer().get<{ id: string }>(`${base}/clients/${await clientId("libredb-platform")}/service-account-user`);
  const refs = [];
  for (const role of roles) refs.push(await customer().get<{ id: string; name: string }>(`${base}/clients/${management}/roles/${role}`));
  await customer().write(method, `${base}/users/${account.id}/role-mappings/clients/${management}`, refs, [204]);
}

/** The manual check of keycloak-configure with the given client secrets: the exit code and the findings. */
async function check(secrets = shared): Promise<{ exitCode: number; findings: readonly string[]; logged: string[] }> {
  const logged: string[] = [];
  const observed = await observeManualKeycloak({
    issuer: installation.issuer,
    realm: installation.realm,
    adminUrl: installation.keycloak.adminUrl,
    clientSecrets: secrets,
    clientIds: ["libredb", ...expected.appClients.map((client) => client.representation.clientId)],
    fetch: trusted,
    log: (line) => logged.push(line),
  });
  try {
    checkManualKeycloak(observed, expected);
    return { exitCode: ExitCode.Ok, findings: [], logged };
  } catch (error) {
    if (!(error instanceof ManualKeycloakError)) throw error;
    return { exitCode: error.exitCode, findings: error.findings, logged };
  }
}

beforeAll(async () => {
  docker(["rm", "--force", KEYCLOAK], false);
  await startKeycloak();
  await customer().write("POST", "/admin/realms", { realm: REALM, enabled: true }, [201]);
  exported = await keycloakExport(installation);
  // The identity team applies the export, and assigns the service account roles in the console instead.
  await applyExport(customer(), exported, (request) => !grantsServiceAccountRoles(request));
  for (const [key, id] of [["studio", "libredb-studio"], ["platform", "libredb-platform"]] as const) {
    const secret = await customer().get<{ value: string }>(`${base}/clients/${await clientId(id)}/client-secret`);
    shared[key] = secret.value;
  }
}, LONG);

afterAll(() => {
  docker(["rm", "--force", KEYCLOAK], false);
  rmSync(scratch, { recursive: true, force: true });
});

describe("a realm configured by the site from the export", () => {
  test(
    "after the export is applied to an empty realm and the service account roles are assigned by hand, the manual check passes with only the two client secrets",
    async () => {
      const before = await check();
      expect(before.exitCode).toBe(ExitCode.PreflightFailed);
      expect(before.findings.join("\n")).toContain("view-users");

      await serviceAccountRoles("POST", ["view-users", "view-clients"]);
      const result = await check();
      expect({ exitCode: result.exitCode, findings: result.findings }).toEqual({ exitCode: ExitCode.Ok, findings: [] });
      // Only the two app clients authenticate, and neither secret nor a token reaches the log.
      expect(result.logged.some((line) => line.includes("as libredb-platform"))).toBe(true);
      expect(result.logged.filter((line) => line.includes(shared.studio) || line.includes(shared.platform))).toEqual([]);
      expect(result.logged.filter((line) => /admin-cli|master/.test(line))).toEqual([]);
    },
    LONG,
  );

  test(
    "without view-users on the Platform service account the manual check fails with exit 3 naming view-users",
    async () => {
      await serviceAccountRoles("DELETE", ["view-users"]);
      try {
        const result = await check();
        expect(result.exitCode).toBe(ExitCode.PreflightFailed);
        expect(result.findings).toEqual([
          `the service account of client libredb-platform cannot list the users of realm ${REALM} (403): give it the ` +
            "realm-management role view-users, which Platform's session recheck, directory sync and grant search need",
        ]);
      } finally {
        await serviceAccountRoles("POST", ["view-users"]);
      }
      expect((await check()).exitCode).toBe(ExitCode.Ok);
    },
    LONG,
  );

  test(
    "a libredb-mobile without the audience mapper fails the manual check with exit 3 naming the mapper",
    async () => {
      const mobile = await clientId("libredb-mobile");
      const mappers = await customer().get<{ id: string; protocolMapper: string }[]>(`${base}/clients/${mobile}/protocol-mappers/models`);
      const audience = mappers.find((mapper) => mapper.protocolMapper === "oidc-audience-mapper");
      if (audience === undefined) throw new Error("libredb-mobile has no audience mapper");
      await customer().write("DELETE", `${base}/clients/${mobile}/protocol-mappers/models/${audience.id}`, undefined, [204]);
      try {
        const result = await check();
        expect(result.exitCode).toBe(ExitCode.PreflightFailed);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toStartWith("client libredb-mobile lacks a protocol mapper of type oidc-audience-mapper");
      } finally {
        const { id: _id, ...mapper } = audience;
        await customer().write("POST", `${base}/clients/${mobile}/protocol-mappers/models`, mapper, [201]);
      }
      expect((await check()).exitCode).toBe(ExitCode.Ok);
    },
    LONG,
  );

  test(
    "a wrong libredb-studio secret fails the manual check with exit 3 naming libredb-studio",
    async () => {
      const result = await check({ ...shared, studio: generateSecret() });
      expect(result.exitCode).toBe(ExitCode.PreflightFailed);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toStartWith("Keycloak refused the secret of client libredb-studio at token introspection");
      expect(result.findings[0]).toContain("keycloak.external.studioClientSecretEnv");
    },
    LONG,
  );
});
