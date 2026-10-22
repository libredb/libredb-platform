// The browser suite of a Helm install: on the installation run-e2e.sh made on kind, the first admin signs in for the
// first time (new password and TOTP), sees the license, connects a target PostgreSQL and grants a Keycloak user read
// access; the user reads the table in Studio and cannot write to it; the grant's revocation reaches Studio within
// seconds; and Platform's audit log shows the user's statement. Platform and Studio never call each other, so every
// effect crossed the bridge schema of the shared PostgreSQL. The UI steps are the installer's own browser helpers
// (installer/e2e/helpers), so a Helm install is held to what a Docker install is held to. Each step saves a
// screenshot under LIBREDB_E2E_SCREENSHOTS.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  createConnection,
  deleteConnection,
  FIRST_ADMIN,
  firstLoginToPlatform,
  grantAccess,
  grantRemoved,
  openConnection,
  revokeGrant,
  signedInFirstAdmin,
  signInFirstAdminToPlatform,
  type FirstLogin,
} from "../helpers/platform";
import { openStudioConsole, signInToStudioAs, STUDIO_URL, studioRequest, type StudioAnswer } from "../helpers/studio";
import {
  createKeycloakUser,
  deleteKeycloakUser,
  kubectl,
  PLATFORM_URL,
  psqlAsSuperuser,
  removeTargetDatabase,
  secretValue,
  startTargetDatabase,
  stopKeycloakForward,
  targetRowCount,
  type KeycloakUser,
  type TargetDatabase,
} from "./k8s";

test.describe.configure({ mode: "serial" });

const SHOTS = process.env.LIBREDB_E2E_SCREENSHOTS ?? join("test-results", "helm-screenshots");
const REVOCATION_LIMIT_MS = 15_000;

const firstAdmin: FirstLogin = {
  username: FIRST_ADMIN,
  temporaryPassword: secretValue("libredb-keycloak-config", "first-admin-password"),
  newPassword: `K8s-${Date.now()}-Admin-Pass!`,
  email: "admin@e2e.libredb.test",
  firstName: "Helm",
  lastName: "Admin",
};

let target: TargetDatabase;
let user: KeycloakUser;
let adminContext: BrowserContext;
let userContext: BrowserContext;
let platform: Page;
let studio: Page;
let connection: { id: string; name: string } | undefined;

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

function studioId(): string {
  if (connection === undefined) throw new Error("no connection yet");
  return `seed:${connection.id}`;
}

function query(page: Page, sql: string): Promise<StudioAnswer> {
  return studioRequest(page, "/api/db/query", { body: { connectionId: studioId(), sql } });
}

async function managedIds(page: Page): Promise<string[]> {
  const answer = await studioRequest(page, "/api/connections/managed");
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return (answer.body as { connections: { id: string }[] }).connections.map((managed) => managed.id);
}

test.beforeAll(async ({ browser }) => {
  const image = kubectl(["get", "statefulset", "libredb-postgres", "-o", "jsonpath={.spec.template.spec.containers[0].image}"]);
  target = startTargetDatabase(image);
  user = await createKeycloakUser(`analyst-${Date.now().toString(36)}`, "user");
  adminContext = await browser.newContext();
  userContext = await browser.newContext();
  platform = await adminContext.newPage();
  studio = await userContext.newPage();
});

test.afterAll(async () => {
  if (connection !== undefined) {
    try {
      // The admin's session from the first test is still open.
      await deleteConnection(platform, connection);
    } catch (error) {
      console.log(`cleanup: the connection could not be deleted: ${String(error)}`);
    }
  }
  if (user !== undefined) await deleteKeycloakUser(user.id);
  removeTargetDatabase();
  stopKeycloakForward();
  await adminContext?.close();
  await userContext?.close();
});

test("the first admin signs in to Platform for the first time with a new password and TOTP", async () => {
  // A rerun against the same installation signs in with the password and TOTP device the first run set.
  if (signedInFirstAdmin() === undefined) {
    const { completed } = await firstLoginToPlatform(platform, firstAdmin);
    expect(completed).toContain("password");
    expect(completed).toContain("totp");
  } else {
    await signInFirstAdminToPlatform(platform, firstAdmin);
  }
  await expect(platform).toHaveURL((url) => url.origin === PLATFORM_URL && url.pathname !== "/login");
  await platform.waitForLoadState("networkidle");
  await shot(platform, "01-platform-after-first-login");
});

test("the license page shows the license the chart installed as active", async () => {
  await platform.goto("/admin/license");
  // The license id the script read from the license file it installed.
  const licenseId = process.env.LIBREDB_E2E_LICENSE_ID;
  if (licenseId !== undefined && licenseId !== "") await expect(platform.locator("body")).toContainText(licenseId);
  await expect(platform.locator("body")).toContainText(/active/i);
  await shot(platform, "02-platform-license");
});

test("the admin connects the target PostgreSQL, sealing its credentials to Studio's key", async () => {
  const name = `orders-${Date.now().toString(36)}`;
  await createConnection(platform, {
    name,
    host: target.host,
    port: target.port,
    database: target.database,
    read: target.read,
    write: target.write,
  });
  const id = await openConnection(platform, name);
  connection = { id, name };
  // Platform stores only lsb1 envelopes: neither password is in its tables.
  const stored = psqlAsSuperuser("libredb", `SELECT "readSecret" || ' ' || coalesce("writeSecret", '') FROM platform.database_connections WHERE id = '${id}'`);
  expect(stored).toMatch(/^lsb1\./);
  expect(stored).not.toContain(target.read.password);
  expect(stored).not.toContain(target.write.password);
  await shot(platform, "03-platform-connection");
});

test("the admin grants a Keycloak user read access", async () => {
  await grantAccess(platform, user.username, "read");
  await shot(platform, "04-platform-grant-read");
});

test("the user signs in to Studio, sees the connection and reads the table, but cannot write", async () => {
  await signInToStudioAs(studio, user);
  await openStudioConsole(studio);
  await expect.poll(() => managedIds(studio), { timeout: 30_000 }).toContain(studioId());
  const read = await query(studio, `SELECT item, qty FROM ${target.table} ORDER BY id`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(JSON.stringify(read.body)).toContain("keyboard");
  const before = targetRowCount();
  const write = await query(studio, `INSERT INTO ${target.table} (item, qty) VALUES ('blocked', 1)`);
  expect(write.status, JSON.stringify(write.body)).not.toBe(200);
  expect(targetRowCount()).toBe(before);
  await studio.goto(STUDIO_URL);
  await studio.waitForLoadState("networkidle");
  await expect(studio.locator("body")).toContainText(connection?.name ?? "");
  await shot(studio, "05-studio-user-sees-connection");
  // The same read through Studio's editor, as the user runs it.
  const editor = studio.locator(".monaco-editor").first();
  await editor.click();
  await studio.keyboard.type(`SELECT item, qty FROM ${target.table} ORDER BY id`);
  await studio.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(studio.locator("body")).toContainText("monitor", { timeout: 30_000 });
  await shot(studio, "05b-studio-user-query-result");
});

test("revoking the grant in Platform takes the connection away from Studio within seconds", async () => {
  await openConnection(platform, connection?.name ?? "");
  const { answeredAt } = await revokeGrant(platform, user.username);
  await grantRemoved(platform, user.username);
  await openStudioConsole(studio);
  let latency = -1;
  for (;;) {
    const answer = await query(studio, "SELECT 1");
    if (answer.status === 404) {
      latency = Date.now() - answeredAt;
      break;
    }
    if (Date.now() - answeredAt > REVOCATION_LIMIT_MS) throw new Error(`Studio still answered ${answer.status} after the revocation`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(`revocation latency: ${latency} ms`);
  test.info().annotations.push({ type: "revocation latency", description: `${latency} ms` });
  await shot(platform, "06-platform-grant-revoked");
});

test("Platform's audit log shows the user's statement", async () => {
  await expect
    .poll(
      async () => {
        await platform.goto("/audit");
        return platform.locator("body").innerText();
      },
      { timeout: 60_000 },
    )
    .toContain(user.username);
  await shot(platform, "07-platform-audit-log");
});
