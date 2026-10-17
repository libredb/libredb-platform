// Runs the managed Keycloak of the rendered compose file against a PostgreSQL server provisioned as the
// postgres-provision step does, then hands its access over from the bootstrap client to libredb-installer through the
// loopback port, as the keycloak-deploy step does. The Caddy edge with the rendered Caddyfile stands in front of it.
// Keycloak's port 8080 is published on 127.0.0.1:LIBREDB_IT_KEYCLOAK_PORT (default 18080, the default
// keycloak.adminPort) and the edge's 443 on 127.0.0.1:LIBREDB_IT_EDGE_PORT (default 18443). LIBREDB_IT_PREFIX names
// the containers, the network and the scratch directory (default libredb-it-kc).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { DockerPsqlRunner } from "../../../src/adapters/psql-docker";
import { tokenPath } from "../../../src/adapters/keycloak-admin";
import { embeddedRelease } from "../../../src/cli/release";
import { loadConfig } from "../../../src/config/load";
import { managedRealm } from "../../../src/keycloak/desired";
import { Redactor } from "../../../src/log/redact";
import { computeDesired } from "../../../src/model/desired";
import { renderCaddyfile } from "../../../src/render/caddyfile";
import { renderCompose, renderPgHba } from "../../../src/render/compose";
import { generateSecret } from "../../../src/secrets/generate";
import { APP_ROLES, type AppRole } from "../../../src/sql/provision";
import { emptyState } from "../../../src/state/store";
import {
  applyProvision,
  observeProvision,
  planProvisionRun,
  type ProvisionTarget,
} from "../../../src/steps/postgres-provision";
import {
  BOOTSTRAP_CLIENT_ID,
  INSTALLER_CLIENT_ID,
  keycloakEnvContent,
  parseEnvFile,
  requireInstallerAccess,
  runHandover,
  type HandoverTarget,
} from "../../../src/steps/keycloak-handover";
import { createCa } from "../../../src/tls/ca";
import { issueLeaf } from "../../../src/tls/leaf";
import { TRUST_FIXTURE } from "../../unit/render/fixture";

const PREFIX = process.env.LIBREDB_IT_PREFIX ?? "libredb-it-kc";
const KEYCLOAK_PORT = Number(process.env.LIBREDB_IT_KEYCLOAK_PORT ?? "18080");
const EDGE_PORT = Number(process.env.LIBREDB_IT_EDGE_PORT ?? "18443");
const NETWORK = `${PREFIX}-net`;
const POSTGRES = `${PREFIX}-postgres`;
const KEYCLOAK = `${PREFIX}-keycloak`;
const EDGE = `${PREFIX}-edge`;
const LONG = 15 * 60_000;
const REALM = "libredb";

const packageRoot = join(import.meta.dir, "..", "..", "..");
const config = loadConfig({
  file: join(packageRoot, "test", "fixtures", "configs", "docker.yaml"),
  sets: [`keycloak.adminPort=${KEYCLOAK_PORT}`],
});
const desired = computeDesired(config, embeddedRelease());
const BASE_URL = desired.keycloak.adminUrl;

interface ComposeService {
  image: string;
  command: string[];
  environment: Record<string, string>;
  healthcheck: { test: string[] };
}
const services = (parse(renderCompose(desired, TRUST_FIXTURE)) as { services: Record<string, ComposeService> }).services;

const scratch = mkdtempSync(join(tmpdir(), `${PREFIX}-`));
const redactor = new Redactor();
const superuserPassword = generateSecret();
const passwords = Object.fromEntries(APP_ROLES.map((role) => [role, generateSecret()])) as Record<AppRole, string>;
const bootstrapSecret = generateSecret();
const keycloakEnvFile = join(scratch, "env", "keycloak.env");
const installerEnvFile = join(scratch, "secrets", "installer.env");

/** Every Keycloak request of the current run, as `METHOD path`. */
let requests: string[] = [];
const recordingFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
  return fetch(input, init);
}) as typeof fetch;

const handoverTarget: HandoverTarget = {
  baseUrl: BASE_URL,
  realm: REALM,
  keycloakEnvFile,
  installerEnvFile,
  owner: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  redactor,
  log: () => {},
  fetch: recordingFetch,
};

function docker(args: readonly string[], check = true): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`docker ${args.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

function removeEverything(): void {
  docker(["rm", "--force", "--volumes", EDGE, KEYCLOAK, POSTGRES], false);
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

function health(container: string): string {
  return docker(["inspect", "--format", "{{.State.Health.Status}}", container]).stdout.trim();
}

async function startPostgresWith(ca: Awaited<ReturnType<typeof createCa>>): Promise<void> {
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
    desired.images.postgres,
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
}

/** Provisions database keycloak and its role as the postgres-provision step does. */
async function provision(): Promise<void> {
  const target: ProvisionTarget = {
    runner: new DockerPsqlRunner({
      image: desired.images.postgres,
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
  const state = emptyState();
  const actions = planProvisionRun(await observeProvision(target), target, state);
  await applyProvision(actions, target, state, () => {});
}

function startKeycloak(): void {
  const keycloak = services.keycloak;
  if (keycloak === undefined) throw new Error("the rendered compose file has no keycloak service");
  const [kind, ...healthCommand] = keycloak.healthcheck.test;
  if (kind !== "CMD") throw new Error(`unexpected healthcheck form ${kind}`);
  writeFileSync(keycloakEnvFile, keycloakEnvContent(passwords.keycloak, bootstrapSecret), { mode: 0o600 });
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
}

async function startEdge(ca: Awaited<ReturnType<typeof createCa>>): Promise<void> {
  const edge = join(scratch, "edge");
  const edgeTls = join(scratch, "edge-tls");
  for (const dir of [edge, edgeTls]) {
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
  }
  writeFileSync(join(edge, "Caddyfile"), renderCaddyfile(desired), { mode: 0o644 });
  for (const site of desired.edge.sites) {
    const leaf = await issueLeaf(ca, [site.host], new Date());
    writeFileSync(join(edgeTls, `${site.host}.crt`), leaf.certPem, { mode: 0o644 });
    writeFileSync(join(edgeTls, `${site.host}.key`), leaf.keyPem, { mode: 0o644 });
  }
  docker([
    "run",
    "--detach",
    "--name",
    EDGE,
    "--network",
    NETWORK,
    "--publish",
    `127.0.0.1:${EDGE_PORT}:443`,
    "--volume",
    `${edge}:/etc/caddy:ro`,
    "--volume",
    `${edgeTls}:/etc/libredb/tls:ro`,
    desired.images.edge,
  ]);
  await waitFor(EDGE, () => edgeStatus("/realms/") !== "000", 60_000);
}

/** The status the edge answers for a path of the auth host, through curl with the test CA; 000 when unreachable. */
function edgeStatus(path: string): string {
  const result = Bun.spawnSync(
    [
      "curl",
      "--silent",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "--cacert",
      join(scratch, "ca", "ca.crt"),
      "--resolve",
      `${desired.hosts.auth}:${EDGE_PORT}:127.0.0.1`,
      `https://${desired.hosts.auth}:${EDGE_PORT}${path}`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  return result.stdout.toString().trim();
}

async function tokenStatus(realm: string, clientId: string, clientSecret: string): Promise<{ status: number; token?: string }> {
  const response = await fetch(`${BASE_URL}${tokenPath(realm)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  const body = (await response.json()) as { access_token?: string };
  return { status: response.status, ...(body.access_token === undefined ? {} : { token: body.access_token }) };
}

function installerSecret(): string {
  const secret = parseEnvFile(readFileSync(installerEnvFile, "utf8")).get("KEYCLOAK_INSTALLER_CLIENT_SECRET");
  if (secret === undefined) throw new Error("installer.env holds no secret");
  return secret;
}

async function installerToken(): Promise<string> {
  const result = await tokenStatus(REALM, INSTALLER_CLIENT_ID, installerSecret());
  if (result.token === undefined) throw new Error(`libredb-installer got no token: ${result.status}`);
  return result.token;
}

beforeAll(async () => {
  removeEverything();
  for (const dir of ["ca", "env", "secrets"]) mkdirSync(join(scratch, dir), { mode: dir === "ca" ? 0o755 : 0o700 });
  chmodSync(join(scratch, "ca"), 0o755);
  const ca = await createCa({ commonName: `${PREFIX} test CA`, now: new Date() });
  writeFileSync(join(scratch, "ca", "ca.crt"), ca.certPem, { mode: 0o644 });
  docker(["network", "create", NETWORK]);
  await startPostgresWith(ca);
  await provision();
  startKeycloak();
  await waitFor(KEYCLOAK, () => health(KEYCLOAK) === "healthy", 600_000);
  await startEdge(ca);
  await runHandover(handoverTarget);
}, LONG);

afterAll(() => {
  removeEverything();
  rmSync(scratch, { recursive: true, force: true });
});

describe("keycloak access handover", () => {
  test("after the handover a client-credentials request for libredb-bootstrap in realm master returns 401 and a libredb-installer token reads /admin/realms/libredb, which holds brute force detection, the password policy and saved events from its creation", async () => {
    expect((await tokenStatus("master", BOOTSTRAP_CLIENT_ID, bootstrapSecret)).status).toBe(401);
    const response = await fetch(`${BASE_URL}/admin/realms/${REALM}`, {
      headers: { authorization: `Bearer ${await installerToken()}` },
    });
    expect(response.status).toBe(200);
    const realm = (await response.json()) as { attributes?: Record<string, string>; registrationAllowed?: boolean };
    expect(realm.attributes?.["libredb.managed"]).toBe("true");
    expect(realm.registrationAllowed).toBe(false);
    // Keycloak holds every setting the realm was created with, so keycloak-configure finds nothing to update.
    expect(realm).toMatchObject(managedRealm(REALM));

    const env = readFileSync(keycloakEnvFile, "utf8");
    expect(env).not.toContain("KC_BOOTSTRAP");
    expect(env).toBe(`KC_DB_PASSWORD=${passwords.keycloak}\n`);
    expect((statSync(installerEnvFile).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(keycloakEnvFile).mode & 0o777).toString(8)).toBe("600");
  });

  test("a libredb-installer token gets 403 on GET /admin/realms/master", async () => {
    const response = await fetch(`${BASE_URL}/admin/realms/master`, {
      headers: { authorization: `Bearer ${await installerToken()}` },
    });
    expect(response.status).toBe(403);
  });

  test("a later run authenticates as libredb-installer in realm libredb and sends only GET requests to the Admin API", async () => {
    requests = [];
    await requireInstallerAccess(handoverTarget);
    expect(requests).toEqual([`POST /realms/${REALM}/protocol/openid-connect/token`, `GET /admin/realms/${REALM}`]);
  });

  test("a handover that stopped after deleting the bootstrap client finishes with libredb-installer alone", async () => {
    writeFileSync(keycloakEnvFile, keycloakEnvContent(passwords.keycloak, bootstrapSecret), { mode: 0o600 });
    requests = [];
    await runHandover(handoverTarget);
    expect(readFileSync(keycloakEnvFile, "utf8")).toBe(`KC_DB_PASSWORD=${passwords.keycloak}\n`);
    expect(requests.filter((request) => request.includes("/admin/")).every((request) => request.startsWith("GET "))).toBe(
      true,
    );
  });

  test("the edge answers 404 on https://auth.libredb.test/admin/ and forwards the realm's discovery document", () => {
    expect(edgeStatus("/admin/")).toBe("404");
    expect(edgeStatus("/admin/master/console/")).toBe("404");
    expect(edgeStatus("/realms/master/.well-known/openid-configuration")).toBe("404");
    expect(edgeStatus(`/realms/${REALM}/.well-known/openid-configuration`)).toBe("200");
  });
});
