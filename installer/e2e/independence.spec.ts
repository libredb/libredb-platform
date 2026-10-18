// Independence of R1 in Docker mode: Platform and Studio meet only in the shared PostgreSQL, so each keeps
// serving, and starts again, while the other is stopped. Against an installation that `apply` made from
// test/fixtures/configs/docker.yaml, the installer's first admin connects a customer PostgreSQL in Platform and grants
// it to a user holding libredb:user, who works in Studio. The spec creates the target database container, that Keycloak
// user and the connection, and removes them at the end. It signs in to Platform as the first admin, whom
// platform-login.spec.ts signs in before it: an installation without a license has one admin seat, which the first
// admin then holds, so the first sign-in of another admin would be refused. Each test starts the container it stopped
// again, even when it fails. The docker command is LIBREDB_E2E_DOCKER's.
import { randomBytes, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createKeycloakUsers, deleteKeycloakUsers, type KeycloakUser } from "./fixtures/keycloak-users";
import { removeTargetDatabase, startTargetDatabase, targetRowCount, type TargetDatabase } from "./fixtures/target-db";
import {
  changeGrantLevel,
  createConnection,
  deleteConnection,
  FIRST_ADMIN,
  firstAdminTemporaryPassword,
  grantAccess,
  openConnection,
  signInFirstAdminToPlatform,
} from "./helpers/platform";
import {
  docker,
  openStudioConsole,
  psqlAsSuperuser,
  signInToStudioAs,
  STUDIO_CONTAINER,
  studioRequest,
  type StudioAnswer,
} from "./helpers/studio";

test.describe.configure({ mode: "serial" });

const PLATFORM_URL = "https://platform.libredb.test";
const PLATFORM_CONTAINER = "libredb-platform-1";
const PLATFORM_READY = "/api/health/ready";
const STUDIO_READY = "/api/ready";
// How long a restarted app may take to pass readiness again; the healthchecks allow about as long.
const START_TIMEOUT_MS = 120_000;

let target: TargetDatabase;
let user: KeycloakUser;
let adminContext: BrowserContext;
let userContext: BrowserContext;
/** The admin's Platform page. */
let platform: Page;
/** The user's Studio page. */
let studio: Page;
let connection: { id: string; name: string; studioId: string };

/**
 * The status of a GET of `path` from `page`'s origin, or 0 when no answer arrived, as while the edge's upstream
 * restarts. The page keeps the document it shows when its app stops, so the request still leaves from that origin.
 */
function statusOf(page: Page, path: string): Promise<number> {
  return page.evaluate(async (target) => {
    try {
      return (await fetch(target, { cache: "no-store" })).status;
    } catch {
      return 0;
    }
  }, path);
}

function query(sql: string): Promise<StudioAnswer> {
  return studioRequest(studio, "/api/db/query", { body: { connectionId: connection.studioId, sql } });
}

/**
 * The status of `sql` run as the user, or 0 when no answer arrived. Chromium fails a request in flight with
 * ERR_NETWORK_CHANGED when Docker adds or removes the interfaces of a container it starts on the same host, so a poll
 * right after a restart retries such a request instead of failing on it.
 */
async function queryStatus(sql: string): Promise<number> {
  try {
    return (await query(sql)).status;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Failed to fetch")) return 0;
    throw error;
  }
}

/** Opens `path` on `page`, again when Chromium failed the navigation with ERR_NETWORK_CHANGED, as `queryStatus` says. */
async function gotoAfterRestart(page: Page, path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(path);
      return;
    } catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !error.message.includes("net::ERR_NETWORK_CHANGED")) throw error;
    }
  }
}

/** The state of a container of the installation, such as running or exited. */
function containerState(container: string): string {
  return docker(["inspect", "--format", "{{.State.Status}}", container]);
}

/** Starts `container` again and waits until `page` sees it ready at `path`. */
async function startAgain(container: string, page: Page, path: string): Promise<void> {
  docker(["start", container]);
  await expect.poll(() => statusOf(page, path), { timeout: START_TIMEOUT_MS, intervals: [1_000] }).toBe(200);
}

/** The level of the user's grant on the connection, as Studio reads it from the bridge. */
function bridgeLevel(): string {
  return psqlAsSuperuser(
    "libredb",
    `SELECT level FROM bridge.grants_v1 WHERE subject = '${user.id}' AND connection_id = '${connection.id}'`,
  );
}

test.beforeAll(async ({ browser }) => {
  target = await startTargetDatabase();
  [user] = createKeycloakUsers(["independence-user"], "user") as [KeycloakUser];
  const options = { baseURL: PLATFORM_URL, ignoreHTTPSErrors: true };
  adminContext = await browser.newContext(options);
  userContext = await browser.newContext(options);

  platform = await adminContext.newPage();
  // The first login, with the profile platform-login.spec.ts gives the first admin, happens only when no earlier spec
  // of the run signed it in.
  await signInFirstAdminToPlatform(platform, {
    username: FIRST_ADMIN,
    temporaryPassword: firstAdminTemporaryPassword(),
    newPassword: `E2e-${randomUUID()}`,
    email: "libredb-admin@libredb.test",
    firstName: "LibreDB",
    lastName: "Admin",
  });
  const name = `Independence ${randomBytes(4).toString("hex")}`;
  await createConnection(platform, {
    name,
    host: target.host,
    port: target.port,
    database: target.database,
    read: target.read,
    write: target.write,
  });
  const id = await openConnection(platform, name);
  connection = { id, name, studioId: `seed:${id}` };
  await grantAccess(platform, user.username, "read");

  studio = await userContext.newPage();
  await signInToStudioAs(studio, user);
  await openStudioConsole(studio);
  await expect.poll(async () => (await query("SELECT 1")).status, { timeout: 10_000 }).toBe(200);
});

test.afterAll(async () => {
  for (const container of [PLATFORM_CONTAINER, STUDIO_CONTAINER]) {
    if (containerState(container) !== "running") docker(["start", container]);
  }
  try {
    if (connection !== undefined) await deleteConnection(platform, connection);
  } finally {
    for (const context of [adminContext, userContext]) await context?.close();
    removeTargetDatabase();
    if (user !== undefined) deleteKeycloakUsers([user.id]);
  }
});

test("Studio stays ready and serves a granted query with Platform stopped", async () => {
  docker(["stop", PLATFORM_CONTAINER]);
  try {
    expect(containerState(PLATFORM_CONTAINER)).toBe("exited");
    expect(await statusOf(platform, PLATFORM_READY)).not.toBe(200);

    expect(await statusOf(studio, STUDIO_READY)).toBe(200);
    const counted = await query(`SELECT count(*) AS independence FROM ${target.table.schema}.${target.table.name}`);
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);

    // Studio also starts without Platform: it loads its governance snapshot from the bridge alone.
    docker(["restart", STUDIO_CONTAINER]);
    await expect.poll(() => statusOf(studio, STUDIO_READY), { timeout: START_TIMEOUT_MS, intervals: [1_000] }).toBe(200);
    await expect.poll(() => queryStatus("SELECT 1"), { timeout: 10_000 }).toBe(200);
    expect(containerState(PLATFORM_CONTAINER)).toBe("exited");
  } finally {
    await startAgain(PLATFORM_CONTAINER, platform, PLATFORM_READY);
  }
});

test("Platform stays ready and changes a grant with Studio stopped", async () => {
  expect(bridgeLevel()).toBe("read");
  const rows = targetRowCount();
  docker(["stop", STUDIO_CONTAINER]);
  try {
    expect(containerState(STUDIO_CONTAINER)).toBe("exited");
    expect(await statusOf(studio, STUDIO_READY)).not.toBe(200);

    expect(await statusOf(platform, PLATFORM_READY)).toBe(200);
    // Platform also starts without Studio.
    docker(["restart", PLATFORM_CONTAINER]);
    await expect.poll(() => statusOf(platform, PLATFORM_READY), { timeout: START_TIMEOUT_MS, intervals: [1_000] }).toBe(200);

    await gotoAfterRestart(platform, `/connections/${connection.id}`);
    await changeGrantLevel(platform, user.username, "write");
    expect(bridgeLevel()).toBe("write");
    expect(containerState(STUDIO_CONTAINER)).toBe("exited");
  } finally {
    await startAgain(STUDIO_CONTAINER, studio, STUDIO_READY);
  }

  // The grant changed while Studio was down holds once it is back: the user's write passes the database.
  const insert = `INSERT INTO ${target.table.schema}.${target.table.name} (item, qty) VALUES ('independence', 1)`;
  await expect.poll(() => queryStatus(insert), { timeout: 10_000, intervals: [500] }).toBe(200);
  expect(targetRowCount()).toBe(rows + 1);
});
