// The browser side of run-restore.sh and run-resilience.sh, in two phases that LIBREDB_E2E_RESTORE_PHASE picks, around
// what the script does to the installation in between: a backup, the loss of the namespace and a restore, or killed
// pods and a restarted node. seed: the first admin signs in for the first time, connects the target PostgreSQL, which
// lives in a namespace of its own, and grants a Keycloak user read access, and the user reads the table in Studio; the
// phase writes what it made to LIBREDB_E2E_RESTORE_STATE. verify: the first admin signs in with the password and TOTP
// device of the seed, Platform still holds the connection with the envelope of the seed, and the user still reads the
// table in Studio, so Studio opened the credential sealed in the seed. Without LIBREDB_E2E_RESTORE_PHASE, as in
// run-e2e.sh, the suite skips.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createConnection, FIRST_ADMIN, grantAccess, openConnection, signInFirstAdminToPlatform, type FirstLogin } from "../helpers/platform";
import { openStudioConsole, signInToStudioAs, STUDIO_URL, studioRequest } from "../helpers/studio";
import { createKeycloakUser, kubectl, psqlAsSuperuser, secretValue, startTargetDatabase, stopKeycloakForward, type KeycloakUser, type TargetDatabase } from "./k8s";

const PHASE = process.env.LIBREDB_E2E_RESTORE_PHASE;
const STATE = process.env.LIBREDB_E2E_RESTORE_STATE ?? join("test-results", "restore-state.json");
const SHOTS = process.env.LIBREDB_E2E_SCREENSHOTS ?? join("test-results", "restore-screenshots");

interface RestoreState {
  target: TargetDatabase;
  user: KeycloakUser;
  connection: { id: string; name: string };
  envelope: string;
}

test.describe.configure({ mode: "serial" });
test.skip(PHASE !== "seed" && PHASE !== "verify", "run by run-restore.sh and run-resilience.sh only");

let adminContext: BrowserContext;
let userContext: BrowserContext;
let platform: Page;
let studio: Page;

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

function firstAdmin(): FirstLogin {
  return {
    username: FIRST_ADMIN,
    temporaryPassword: secretValue("libredb-keycloak-config", "first-admin-password"),
    newPassword: `Restore-${Date.now()}-Admin-Pass!`,
    email: "admin@e2e.libredb.test",
    firstName: "Restore",
    lastName: "Admin",
  };
}

function envelopeOf(id: string): string {
  return psqlAsSuperuser("libredb", `SELECT "readSecret" FROM platform.database_connections WHERE id = '${id}'`);
}

async function userReadsTable(state: RestoreState): Promise<void> {
  await signInToStudioAs(studio, state.user);
  await openStudioConsole(studio);
  const connectionId = `seed:${state.connection.id}`;
  await expect
    .poll(async () => {
      const answer = await studioRequest(studio, "/api/connections/managed");
      return answer.status === 200 ? (answer.body as { connections: { id: string }[] }).connections.map((managed) => managed.id) : [];
    }, { timeout: 60_000 })
    .toContain(connectionId);
  const read = await studioRequest(studio, "/api/db/query", {
    body: { connectionId, sql: `SELECT item, qty FROM ${state.target.table} ORDER BY id` },
  });
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(JSON.stringify(read.body)).toContain("keyboard");
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext();
  userContext = await browser.newContext();
  platform = await adminContext.newPage();
  studio = await userContext.newPage();
});

test.afterAll(async () => {
  stopKeycloakForward();
  await adminContext?.close();
  await userContext?.close();
});

test("seed: the first admin connects the target database and grants a user, who reads the table in Studio", async () => {
  test.skip(PHASE !== "seed");
  if (existsSync(STATE)) throw new Error(`${STATE} exists: the seed phase runs once per backup`);
  const image = kubectl(["get", "statefulset", "libredb-postgres", "-o", "jsonpath={.spec.template.spec.containers[0].image}"]);
  const target = startTargetDatabase(image);
  const user = await createKeycloakUser(`restored-${Date.now().toString(36)}`, "user");
  await signInFirstAdminToPlatform(platform, firstAdmin());
  const name = `restore-${Date.now().toString(36)}`;
  await createConnection(platform, { name, host: target.host, port: target.port, database: target.database, read: target.read, write: target.write });
  const id = await openConnection(platform, name);
  await grantAccess(platform, user.username, "read");
  const state: RestoreState = { target, user, connection: { id, name }, envelope: envelopeOf(id) };
  expect(state.envelope).toMatch(/^lsb1\./);
  await userReadsTable(state);
  writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
  await shot(platform, "seed-platform-connection");
});

test("verify: the installation signs the first admin in and Studio opens the credential sealed in the seed", async () => {
  test.skip(PHASE !== "verify");
  const state = JSON.parse(readFileSync(STATE, "utf8")) as RestoreState;
  // The envelope is the backup's, byte for byte: the restore did not seal it again.
  expect(envelopeOf(state.connection.id)).toBe(state.envelope);
  await signInFirstAdminToPlatform(platform, firstAdmin());
  expect(await openConnection(platform, state.connection.name)).toBe(state.connection.id);
  await shot(platform, "verify-platform-connection");
  await userReadsTable(state);
  await studio.goto(STUDIO_URL);
  await studio.waitForLoadState("networkidle");
  await expect(studio.locator("body")).toContainText(state.connection.name);
  await shot(studio, "verify-studio-connection");
});
