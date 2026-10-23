// The rotations of "Rotate secrets and the seal key" in docs/deploy/install-kubernetes.md, on the installation
// run-rotation.sh made on kind, each step a helm upgrade as the guide gives it. The seal key drill follows the runbook
// of a Docker install (installer/e2e/runbooks.spec.ts): a new key reaches every Studio heartbeat, Platform switches to
// it, a retirement while a credential still uses the old key is refused at once and changes nothing, the admin enters
// the credentials again, and the retirement then takes the old key out of Studio's keyring and its canary out of
// Platform's table, while the granted user keeps querying. Then Studio's JWT_SECRET, Platform's AUTH_SECRET with its
// previous value, Studio's Keycloak client secret and libredb_platform's password are rotated by deleting each from
// Secret libredb-secrets and upgrading. Without LIBREDB_E2E_ROTATION=1, as in run-e2e.sh, the suite skips.
import { execFileSync, spawnSync } from "node:child_process";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { sealKeyId } from "../../src/secrets/seal-keys";
import {
  createConnection,
  FIRST_ADMIN,
  grantAccess,
  openConnection,
  signInFirstAdminToPlatform,
  type Credential,
} from "../helpers/platform";
import { openStudioConsole, signInToStudioAs, STUDIO_URL, studioRequest, type StudioAnswer } from "../helpers/studio";
import {
  createKeycloakUser,
  kubectl,
  NAMESPACE,
  PLATFORM_URL,
  psqlAsSuperuser,
  secretValue,
  startTargetDatabase,
  stopKeycloakForward,
  type KeycloakUser,
  type TargetDatabase,
} from "./k8s";

const ENABLED = process.env.LIBREDB_E2E_ROTATION === "1";
const CHART = process.env.LIBREDB_E2E_CHART ?? "";
const VALUES = process.env.LIBREDB_E2E_VALUES ?? "";
const LICENSE = process.env.LIBREDB_E2E_LICENSE ?? "";
const HEARTBEAT_WAIT_MS = 180_000;

test.describe.configure({ mode: "serial" });
test.skip(!ENABLED, "run by run-rotation.sh only");

let target: TargetDatabase;
let user: KeycloakUser;
let adminContext: BrowserContext;
let userContext: BrowserContext;
let platform: Page;
let studio: Page;
let connection: { id: string; name: string };
/** The --set flags of platform.sealKeys the installation runs with, which every later upgrade repeats. */
let sealSets: string[] = [];

/** helm upgrade of the installation with the values of run-rotation.sh and `sets`; returns helm's exit status. */
function upgrade(sets: string[]): { status: number; output: string } {
  const args = ["upgrade", "libredb", CHART, "-n", NAMESPACE, "-f", VALUES, "--set-file", `platform.license.value=${LICENSE}`];
  for (const set of [...sealSets, ...sets]) args.push("--set", set);
  const run = spawnSync("helm", [...args, "--wait", "--wait-for-jobs", "--timeout", "10m"], { encoding: "utf8" });
  return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` };
}

/** The pods of a selector, terminating ones included. */
function podCount(selector: string): number {
  return kubectl(["get", "pods", "-l", selector, "-o", "name"]).split("\n").filter((line) => line !== "").length;
}

/** Whether the ingress answers `url` within 5 seconds with `status`, three times in a row. */
function settled(url: string, status: string): boolean {
  const host = new URL(url).host;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const run = spawnSync("curl", ["-sk", "--max-time", "5", "--resolve", `${host}:443:127.0.0.1`, "-o", "/dev/null", "-w", "%{http_code}", url], { encoding: "utf8" });
    if (run.stdout !== status) return false;
  }
  return true;
}

/**
 * An upgrade that succeeds, once the restarted apps run, their old pods are gone and the ingress stopped sending
 * requests to them. The Studio chart gives its pod no preStop delay, so for a few seconds after a restart the ingress
 * can still send a request to the pod that just stopped, which waits 30 seconds and ends in a 504.
 */
async function upgraded(sets: string[] = []): Promise<void> {
  const run = upgrade(sets);
  expect(run.status, run.output).toBe(0);
  for (const deploy of ["libredb-platform", "libredb-studio"]) kubectl(["rollout", "status", `deploy/${deploy}`, "--timeout=300s"]);
  for (const selector of ["app.kubernetes.io/component=platform", "app.kubernetes.io/name=studio"]) {
    await expect.poll(() => podCount(selector), { timeout: 180_000, intervals: [1_000] }).toBe(1);
  }
  await expect.poll(() => settled(`${STUDIO_URL}/login`, "307") && settled(`${PLATFORM_URL}/api/health/ready`, "200"), { timeout: 180_000, intervals: [1_000] }).toBe(true);
}

interface Heartbeat {
  kids: string[];
  canary: Record<string, string>;
}

/** The live heartbeats of bridge.studio_instance, as the runbook's query reads them. */
function heartbeats(): Heartbeat[] {
  return JSON.parse(
    psqlAsSuperuser(
      "libredb",
      `SELECT coalesce(json_agg(json_build_object('kids', keyring_kids, 'canary', canary) ORDER BY instance_id), '[]')
         FROM bridge.studio_instance WHERE last_seen_at > now() - interval '2 minutes'`,
    ),
  ) as Heartbeat[];
}

function envelopeKids(): { read: string; write: string } {
  return JSON.parse(
    psqlAsSuperuser(
      "libredb",
      `SELECT json_build_object('read', split_part(read_secret, '.', 2), 'write', split_part(write_secret, '.', 2))
         FROM bridge.connections_v1 WHERE connection_id = '${connection.id}'`,
    ),
  ) as { read: string; write: string };
}

function canaryKids(): string[] {
  return JSON.parse(psqlAsSuperuser("libredb", "SELECT coalesce(json_agg(kid ORDER BY kid), '[]') FROM bridge.seal_canary_v1")) as string[];
}

/** The kid of BRIDGE_SEAL_PUBLIC_KEY in the running Platform pod. */
function platformKid(): string {
  return sealKeyId(kubectl(["exec", "deploy/libredb-platform", "--", "printenv", "BRIDGE_SEAL_PUBLIC_KEY"]));
}

function query(): Promise<StudioAnswer> {
  return studioRequest(studio, "/api/db/query", { body: { connectionId: `seed:${connection.id}`, sql: "SELECT 1" } });
}

async function userStillQueries(): Promise<void> {
  await openStudioConsole(studio);
  await expect.poll(async () => (await query()).status, { timeout: 90_000, intervals: [1_000] }).toBe(200);
}

/** Removes one value from the secret store, as the guide's rotation does, so the next upgrade generates it again. */
function deleteStored(name: string): string {
  const value = secretValue("libredb-secrets", name);
  expect(value, name).not.toBe("");
  kubectl(["patch", "secret", "libredb-secrets", "--type", "json", "-p", JSON.stringify([{ op: "remove", path: `/data/${name}` }])]);
  return value;
}

test.beforeAll(async ({ browser }) => {
  const image = kubectl(["get", "statefulset", "libredb-postgres", "-o", "jsonpath={.spec.template.spec.containers[0].image}"]);
  target = startTargetDatabase(image);
  user = await createKeycloakUser(`rotation-${Date.now().toString(36)}`, "user");
  adminContext = await browser.newContext();
  userContext = await browser.newContext();
  platform = await adminContext.newPage();
  studio = await userContext.newPage();
  await signInFirstAdminToPlatform(platform, {
    username: FIRST_ADMIN,
    temporaryPassword: secretValue("libredb-keycloak-config", "first-admin-password"),
    newPassword: `Rotation-${Date.now()}-Admin-Pass!`,
    email: "admin@e2e.libredb.test",
    firstName: "Rotation",
    lastName: "Admin",
  });
  const name = `rotation-${Date.now().toString(36)}`;
  await createConnection(platform, { name, host: target.host, port: target.port, database: target.database, read: target.read, write: target.write });
  connection = { id: await openConnection(platform, name), name };
  await grantAccess(platform, user.username, "read");
  await signInToStudioAs(studio, user);
  await userStillQueries();
});

test.afterAll(async () => {
  stopKeycloakForward();
  await adminContext?.close();
  await userContext?.close();
});

test("seal key rotation: issue, switch, a refused early retirement, re-entry, retirement", async () => {
  test.setTimeout(40 * 60_000);
  const oldKid = envelopeKids().read;
  expect(envelopeKids()).toEqual({ read: oldKid, write: oldKid });
  expect(platformKid()).toBe(oldKid);

  // 1. Add the new key to Studio.
  sealSets = ["platform.sealKeys.issueNew=true"];
  await upgraded();
  let newKid = "";
  await expect
    .poll(
      () => {
        const live = heartbeats();
        newKid = live[0]?.kids.find((kid) => kid !== oldKid) ?? "";
        return newKid !== "" && live.every((row) => row.kids.includes(oldKid) && row.kids.includes(newKid) && row.canary[oldKid] === "ok");
      },
      { timeout: HEARTBEAT_WAIT_MS, intervals: [2_000] },
    )
    .toBe(true);
  expect(platformKid()).toBe(oldKid);
  // The same values again issue no second key.
  await upgraded();
  expect(heartbeats().every((row) => row.kids.length === 2)).toBe(true);
  await userStillQueries();

  // 2. Switch Platform to the new key; its canary for the new kid turns ok in every heartbeat.
  sealSets = ["platform.sealKeys.issueNew=false", `platform.sealKeys.activeKid=${newKid}`];
  await upgraded();
  expect(platformKid()).toBe(newKid);
  await expect
    .poll(() => heartbeats().every((row) => row.canary[newKid] === "ok" && row.canary[oldKid] === "ok"), {
      timeout: HEARTBEAT_WAIT_MS,
      intervals: [2_000],
    })
    .toBe(true);
  await userStillQueries();

  // Retiring before the re-entry: the bootstrap job refuses at once, naming the connection, and changes nothing.
  const storeBefore = kubectl(["get", "secret", "libredb-secrets", "-o", "jsonpath={.data.seal-keys\\.json}"]);
  const started = Date.now();
  const refused = upgrade([`platform.sealKeys.retire[0]=${oldKid}`]);
  expect(refused.status, refused.output).not.toBe(0);
  expect(Date.now() - started).toBeLessThan(5 * 60_000);
  const log = kubectl(["logs", "job/libredb-bootstrap", "-c", "bootstrap"]);
  expect(log).toContain(`${connection.name} (${connection.id})`);
  expect(kubectl(["get", "secret", "libredb-secrets", "-o", "jsonpath={.data.seal-keys\\.json}"])).toBe(storeBefore);
  expect(canaryKids()).toContain(oldKid);
  await userStillQueries();

  // 3. Platform warns about the credentials sealed to the old key; the admin enters them again.
  await platform.goto(`/connections/${connection.id}`);
  await expect(platform.getByRole("alert").filter({ hasText: "sealed to an earlier Studio key" })).toContainText(oldKid);
  const readGroup = platform.getByRole("group", { name: "Read credential" });
  await readGroup.getByLabel("User", { exact: true }).fill(target.read.user);
  await readGroup.getByLabel("Password", { exact: true }).fill(target.read.password);
  await platform.getByLabel(/I confirm that the read credential can only read/).check();
  await platform.getByLabel("Write credential", { exact: true }).selectOption("set");
  const writeGroup = platform.getByRole("group", { name: "New write credential" });
  await writeGroup.getByLabel("User", { exact: true }).fill((target.write as Credential).user);
  await writeGroup.getByLabel("Password", { exact: true }).fill((target.write as Credential).password);
  await platform.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => envelopeKids(), { timeout: 30_000, intervals: [500] }).toEqual({ read: newKid, write: newKid });
  await userStillQueries();

  // 4. Retire the old key: out of every keyring, its canary row gone, and the user still queries.
  sealSets = ["platform.sealKeys.issueNew=false", `platform.sealKeys.activeKid=${newKid}`, `platform.sealKeys.retire[0]=${oldKid}`];
  await upgraded();
  expect(canaryKids()).not.toContain(oldKid);
  expect(canaryKids()).toContain(newKid);
  await expect
    .poll(
      () => heartbeats().map((row) => ({ old: row.kids.includes(oldKid) || oldKid in row.canary, current: row.canary[newKid] })),
      { timeout: HEARTBEAT_WAIT_MS, intervals: [2_000] },
    )
    .toEqual([{ old: false, current: "ok" }]);
  const stored = JSON.parse(secretValue("libredb-secrets", "seal-keys.json")) as { kid: string; state: string }[];
  expect(stored.map((key) => [key.kid, key.state])).toEqual([
    [oldKid, "retired"],
    [newKid, "live"],
  ]);
  expect(platformKid()).toBe(newKid);
  await userStillQueries();
});

test("Studio's JWT_SECRET: a new value ends every Studio session, and Keycloak's session signs the user in again", async () => {
  test.setTimeout(15 * 60_000);
  const old = deleteStored("studio-jwt-secret");
  await upgraded();
  expect(secretValue("libredb-studio-env", "jwt-secret")).not.toBe(old);
  await openStudioConsole(studio);
  await expect.poll(async () => (await query()).status, { timeout: 60_000 }).toBe(401);
  // The Keycloak session is still alive, so the sign-in completes without the password form, as the runbook says.
  await studio.goto(`${STUDIO_URL}/login`);
  await expect(studio).toHaveURL((url) => url.origin === STUDIO_URL && url.pathname !== "/login", { timeout: 30_000 });
  await expect(studio.locator("#password")).toHaveCount(0);
  await userStillQueries();
});

test("Platform's AUTH_SECRET with its previous value: the admin's session survives the rotation", async () => {
  test.setTimeout(15 * 60_000);
  const old = deleteStored("platform-auth-secret");
  kubectl(["create", "secret", "generic", "libredb-auth-previous", `--from-literal=auth-secret-previous=${old}`]);
  await upgraded(["platform.authSecretPrevious.existingSecret=libredb-auth-previous"]);
  const current = kubectl(["exec", "deploy/libredb-platform", "--", "printenv", "AUTH_SECRET"]);
  expect(current).not.toBe(old);
  expect(kubectl(["exec", "deploy/libredb-platform", "--", "printenv", "AUTH_SECRET_PREVIOUS"])).toBe(old);
  await platform.goto(`/connections/${connection.id}`);
  await expect(platform).toHaveURL((url) => url.origin === PLATFORM_URL && url.pathname === `/connections/${connection.id}`);
  // After the session lifetime, the previous value goes.
  await upgraded();
  expect(spawnSync("kubectl", ["-n", NAMESPACE, "exec", "deploy/libredb-platform", "--", "printenv", "AUTH_SECRET_PREVIOUS"]).status).not.toBe(0);
  kubectl(["delete", "secret", "libredb-auth-previous"]);
});

test("Studio's Keycloak client secret and libredb_platform's password: new values reach Keycloak, PostgreSQL and the apps", async () => {
  test.setTimeout(15 * 60_000);
  const client = deleteStored("keycloak-client-libredb-studio");
  const role = deleteStored("postgres-platform-password");
  await upgraded();
  expect(secretValue("libredb-studio-env", "oidc-client-secret")).not.toBe(client);
  expect(kubectl(["exec", "deploy/libredb-platform", "--", "printenv", "DATABASE_URL"])).not.toContain(role);
  // A new Studio sign-in goes through Keycloak with the new client secret.
  await studio.context().clearCookies();
  await signInToStudioAs(studio, user);
  await userStillQueries();
  // Platform reads its database with the new password.
  await platform.goto("/audit");
  await expect(platform).toHaveURL((url) => url.pathname === "/audit");
  expect(execFileSync("curl", ["-sk", "--resolve", `${new URL(PLATFORM_URL).host}:443:127.0.0.1`, "-o", "/dev/null", "-w", "%{http_code}", `${PLATFORM_URL}/api/health/ready`], { encoding: "utf8" })).toBe("200");
});
