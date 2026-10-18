// The interop suite in Docker mode: against an installation that
// `apply` made from test/fixtures/configs/docker.yaml, an admin connects a customer PostgreSQL in Platform and grants
// it, and two Keycloak users holding libredb:user, A and B, work in Studio. Platform and Studio never call each other,
// so every effect below crossed the bridge schema of the shared PostgreSQL.
// The tests run in order and share the installation, the connection and the sessions they build. The suite creates
// the target database container and the two users, and removes them and the connection at the end. The admin is the
// installer's first admin, whom platform-login.spec.ts signs in before it: an installation without a license has one
// admin seat, which the first admin then holds, so the first sign-in of another admin would be refused.
// The revocation and session revocation latencies are measured from the response of Platform's action, with Studio
// polled every 100 ms, and printed.
import { randomBytes, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  createKeycloakUsers,
  deleteKeycloakUsers,
  keycloakSessions,
  type KeycloakUser,
} from "./fixtures/keycloak-users";
import { removeTargetDatabase, startTargetDatabase, targetRowCount, type TargetDatabase } from "./fixtures/target-db";
import {
  changeGrantLevel,
  createConnection,
  deleteConnection,
  FIRST_ADMIN,
  firstAdminTemporaryPassword,
  grantAccess,
  grantRemoved,
  openConnection,
  revokeGrant,
  revokeStudioSessions,
  setStudioSetting,
  signInFirstAdminToPlatform,
  studioSettingValue,
} from "./helpers/platform";
import {
  openStudioConsole,
  psqlAsSuperuser,
  signInToStudioAs,
  STUDIO_URL,
  studioContainerId,
  studioEnvironment,
  studioRequest,
  type StudioAnswer,
} from "./helpers/studio";

test.describe.configure({ mode: "serial" });

const PLATFORM_URL = "https://platform.libredb.test";
const CAPTURE_KEY = "queryLog.statementCapture";
const POLL_INTERVAL_MS = 100;
const REVOCATION_BOUND_MS = 2_000;
// How long a latency is still measured past its bound, so a slow revocation is reported with its real figure.
const LATENCY_LIMIT_MS = 15_000;

interface GovernanceStatus {
  freshness: string;
  snapshot: { loadedAt: string } | null;
  admittedConnections: number | null;
  skipped: { kind: string; id: string; code: string }[];
}

interface ManagedConnections {
  connections: { id: string; name: string }[];
}

interface ErrorBody {
  error?: string;
  code?: string;
}

let target: TargetDatabase;
let userA: KeycloakUser;
let userB: KeycloakUser;
let adminContext: BrowserContext;
let contextA: BrowserContext;
let contextB: BrowserContext;
/** The admin's Platform page. */
let platform: Page;
/** The admin's Studio page, which "SSO from Platform to Studio" opens. */
let adminStudio: Page | undefined;
let studioA: Page;
let studioB: Page;
/** The connection "seal to open" creates. */
let connection: { id: string; name: string } | undefined;

function created(): { id: string; name: string; studioId: string } {
  if (connection === undefined) throw new Error('no connection: "seal to open" creates it');
  return { ...connection, studioId: `seed:${connection.id}` };
}

function adminStudioPage(): Page {
  if (adminStudio === undefined) {
    throw new Error('the admin has no Studio page: "SSO from Platform to Studio" opens it');
  }
  return adminStudio;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends `request` every 100 ms until it answers `expected`, and returns how long after `since` that answer arrived.
 * Until then every answer must be `previous`, the status before the change.
 */
async function latencyUntil(
  request: () => Promise<StudioAnswer>,
  previous: number,
  expected: number,
  since: number,
): Promise<number> {
  for (;;) {
    const sentAt = Date.now();
    const answer = await request();
    const arrivedAt = Date.now();
    if (answer.status === expected) return arrivedAt - since;
    expect(answer.status, `an answer before ${expected}: ${JSON.stringify(answer.body)}`).toBe(previous);
    if (arrivedAt - since > LATENCY_LIMIT_MS) {
      throw new Error(`Studio still answered ${answer.status} ${arrivedAt - since} ms after Platform's action`);
    }
    await sleep(Math.max(0, sentAt + POLL_INTERVAL_MS - Date.now()));
  }
}

/** Prints a measured latency and attaches it to the test's result. */
function report(what: string, latencyMs: number): void {
  console.log(`${what} latency: ${latencyMs} ms`);
  test.info().annotations.push({ type: `${what} latency`, description: `${latencyMs} ms` });
}

async function governance(page: Page): Promise<GovernanceStatus> {
  const answer = await studioRequest(page, "/api/admin/governance");
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return (answer.body as { governance: GovernanceStatus }).governance;
}

async function managedIds(page: Page): Promise<string[]> {
  const answer = await studioRequest(page, "/api/connections/managed");
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return (answer.body as ManagedConnections).connections.map((managed) => managed.id);
}

/** The target table, schema-qualified. */
function targetTable(): string {
  return `${target.table.schema}.${target.table.name}`;
}

/** The capture mode of query events that Studio applies, as its editor shows it to `page`'s user. */
async function appliedCapture(page: Page): Promise<string> {
  return ((await studioRequest(page, "/api/connections/policy")).body as { statementCapture: string }).statementCapture;
}

function query(page: Page, sql: string): Promise<StudioAnswer> {
  return studioRequest(page, "/api/db/query", { body: { connectionId: created().studioId, sql } });
}

function errorOf(answer: StudioAnswer): { status: number; code: string | undefined } {
  return { status: answer.status, code: (answer.body as ErrorBody).code };
}

/** The editor events of a subject in bridge.query_event, oldest first, with their capture and statement. */
function editorEvents(subject: string): { capture: string; statement: string | null }[] {
  const json = psqlAsSuperuser(
    "libredb",
    `SELECT coalesce(json_agg(json_build_object('capture', statement_capture, 'statement', statement)
       ORDER BY started_at, event_id), '[]')
       FROM bridge.query_event WHERE subject = '${subject}' AND source = 'editor'`,
  );
  return JSON.parse(json) as { capture: string; statement: string | null }[];
}

interface AuditRow {
  user: string;
  connection: string;
  source: string;
  statement: string;
  status: string;
}

/** The rows of Platform's audit page, newest first, as the page renders them. */
async function auditRows(page: Page): Promise<AuditRow[]> {
  await page.goto("/audit");
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  // A table row's rendered text separates its cells with tabs.
  const texts = await rows.evaluateAll((elements) =>
    elements.map((row) => (row as unknown as { innerText: string }).innerText),
  );
  return texts
    .map((text) => text.split("\t").map((cell) => cell.trim()))
    .filter((row) => row.length === 9)
    .map(([, user, connectionCell, source, , statement, , , status]) => ({
      user: user as string,
      connection: connectionCell as string,
      source: source as string,
      statement: statement as string,
      status: status as string,
    }));
}

async function signedInStudio(context: BrowserContext, user: KeycloakUser): Promise<Page> {
  const page = await context.newPage();
  await signInToStudioAs(page, user);
  await openStudioConsole(page);
  return page;
}

test.beforeAll(async ({ browser }) => {
  target = await startTargetDatabase();
  [userA, userB] = createKeycloakUsers(["interop-a", "interop-b"], "user") as [KeycloakUser, KeycloakUser];
  const options = { baseURL: PLATFORM_URL, ignoreHTTPSErrors: true };
  adminContext = await browser.newContext(options);
  contextA = await browser.newContext(options);
  contextB = await browser.newContext(options);
  platform = await adminContext.newPage();
  studioA = await signedInStudio(contextA, userA);
  studioB = await signedInStudio(contextB, userB);
});

test.afterAll(async () => {
  try {
    if (connection !== undefined) await deleteConnection(platform, connection);
  } finally {
    for (const context of [adminContext, contextA, contextB]) await context?.close();
    removeTargetDatabase();
    deleteKeycloakUsers([userA, userB].filter((user) => user !== undefined).map((user) => user.id));
  }
});

test("SSO from Platform to Studio", async () => {
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
  await expect(platform).toHaveURL((url) => url.pathname === "/connections");

  // The STUDIO entry opens Studio in a new tab of the same browser, where Keycloak's session signs the admin in
  // without its form: a page that stopped at Keycloak's form would never reach Studio.
  const opened = adminContext.waitForEvent("page");
  await platform.locator('[data-sidebar="sidebar"]').getByRole("link", { name: "Studio", exact: true }).click();
  const studio = await opened;
  await expect(studio).toHaveURL((url) => url.origin === STUDIO_URL && url.pathname !== "/login", { timeout: 30_000 });

  await openStudioConsole(studio);
  const me = await studioRequest(studio, "/api/auth/me");
  expect(me.status).toBe(200);
  expect((me.body as { user: { role: string } }).user.role).toBe("admin");
  adminStudio = studio;
});

test("seal to open", async () => {
  const studio = adminStudioPage();
  const before = await governance(studio);
  expect(before.snapshot, "Studio serves a governance snapshot before the connection is created").not.toBeNull();
  const name = `Interop ${randomBytes(4).toString("hex")}`;

  const startedAt = Date.now();
  const { answeredAt } = await createConnection(platform, {
    name,
    host: target.host,
    port: target.port,
    database: target.database,
    read: target.read,
    write: target.write,
  });
  const id = psqlAsSuperuser("libredb", `SELECT connection_id FROM bridge.connections_v1 WHERE name = '${name}'`);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  connection = { id, name };

  // A snapshot whose load started after the create action began, and that admitted one connection more than before,
  // holds the new connection; the connection is admitted when no skipped row names it.
  const status = await (async () => {
    for (;;) {
      const current = await governance(studio);
      const loadedAt = current.snapshot === null ? 0 : Date.parse(current.snapshot.loadedAt);
      if (loadedAt >= startedAt && current.admittedConnections === (before.admittedConnections ?? 0) + 1) {
        report("seal to open", Date.now() - answeredAt);
        return current;
      }
      if (Date.now() > answeredAt + 5_000) {
        throw new Error(`Studio loaded no snapshot with the new connection within 5 s: ${JSON.stringify(current)}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  })();
  expect(status.freshness).toBe("ok");
  expect(status.skipped.filter((item) => item.kind === "connection" && item.id === id)).toEqual([]);
});

test("grant to list", async () => {
  const { id, name, studioId } = created();
  expect(await openConnection(platform, name)).toBe(id);
  await grantAccess(platform, userA.username, "read");

  await expect.poll(() => managedIds(studioA), { timeout: 5_000, intervals: [POLL_INTERVAL_MS] }).toEqual([studioId]);
  expect(await managedIds(studioB)).toEqual([]);

  // B asks for A's connection by its id, and for a connection of its own making.
  expect(errorOf(await query(studioB, "SELECT 1"))).toEqual({ status: 404, code: "CONNECTION_NOT_FOUND" });
  const inline = await studioRequest(studioB, "/api/db/query", {
    body: {
      connection: {
        id: "interop-inline",
        name: "Inline",
        type: "postgres",
        host: target.host,
        port: target.port,
        database: target.database,
        user: target.read.user,
        password: target.read.password,
      },
      sql: "SELECT 1",
    },
  });
  expect(errorOf(inline)).toEqual({ status: 403, code: "CUSTOM_CONNECTIONS_DISABLED" });
});

test("database enforces read-only", async () => {
  const { id } = created();
  const insert = `INSERT INTO ${targetTable()} (item, qty) VALUES ('interop-write', 1)`;
  const rows = targetRowCount();

  // Studio opens the connection with the read credential of A's grant, and the target refuses the write itself:
  // Studio refuses the request and passes PostgreSQL's permission error on.
  const refused = await query(studioA, insert);
  expect(refused.status >= 400 && refused.status < 500, `${refused.status} ${JSON.stringify(refused.body)}`).toBe(true);
  expect((refused.body as ErrorBody).error).toContain(`permission denied for table ${target.table.name}`);
  expect(targetRowCount()).toBe(rows);

  await platform.goto(`/connections/${id}`);
  await changeGrantLevel(platform, userA.username, "write");
  await expect
    .poll(async () => (await query(studioA, insert)).status, { timeout: 5_000, intervals: [POLL_INTERVAL_MS] })
    .toBe(200);
  expect(targetRowCount()).toBe(rows + 1);
});

test("query event visible in Platform audit", async () => {
  const { name, studioId } = created();
  expect(await appliedCapture(studioA), "the editor statement is found by its text").not.toBe("none");

  const editor = await query(studioA, `SELECT count(*) AS interop_audit FROM ${targetTable()}`);
  expect(editor.status, JSON.stringify(editor.body)).toBe(200);
  for (const step of [
    { action: "begin" },
    { action: "query", sql: `UPDATE ${targetTable()} SET qty = qty + 1 WHERE item = 'seed'` },
    { action: "commit" },
  ]) {
    const answer = await studioRequest(studioA, "/api/db/transaction", { body: { connectionId: studioId, ...step } });
    expect({ action: step.action, status: answer.status }).toEqual({ action: step.action, status: 200 });
  }
  const profile = await studioRequest(studioA, "/api/db/profile", {
    body: { connectionId: studioId, tablePath: [target.table.schema, target.table.name], columns: ["item", "qty"] },
  });
  expect(profile.status, JSON.stringify(profile.body)).toBe(200);
  const ranAt = Date.now();

  // Studio names an OIDC user by the email claim first, so that is the username its events carry.
  const summary = async () => {
    const mine = (await auditRows(platform)).filter((row) => row.user === userA.email);
    const seen = (source: string, status: string, match: (row: AuditRow) => boolean) =>
      mine.some(
        (row) => row.source === source && row.status.includes(status) && match(row) && row.connection.includes(name),
      );
    return {
      editor: seen("editor", "success", (row) => row.statement.includes("interop_audit")),
      transactionOpen: seen("transaction", "success", (row) => row.status.includes("open")),
      transactionCommitted: seen("transaction", "success", (row) => row.status.includes("committed")),
      profile: seen("profile", "success", () => true),
      unknownConnection: mine.filter((row) => row.connection.includes("unknown connection")).length,
    };
  };
  // A timeout of 0 would wait without end, so the poll gets at least 1 ms.
  await expect
    .poll(summary, { timeout: Math.max(1, ranAt + 5_000 - Date.now()), intervals: [250] })
    .toEqual({ editor: true, transactionOpen: true, transactionCommitted: true, profile: true, unknownConnection: 0 });
});

test("settings change without restart", async () => {
  const containerBefore = studioContainerId();
  const previous = await studioSettingValue(platform, CAPTURE_KEY);
  expect(previous, "Platform seeds the capture of governance installs").not.toBe("Studio default");

  try {
    for (const capture of ["full", "none"] as const) {
      await setStudioSetting(platform, CAPTURE_KEY, capture);
      // The editor shows the capture mode it applies, so the next statement runs once Studio has applied the change.
      await expect.poll(() => appliedCapture(studioA), { timeout: 5_000, intervals: [POLL_INTERVAL_MS] }).toBe(capture);

      const count = editorEvents(userA.id).length;
      const sql = `SELECT '${capture}' AS interop_capture`;
      const answer = await query(studioA, sql);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      await expect.poll(() => editorEvents(userA.id).length, { timeout: 5_000 }).toBe(count + 1);
      expect(editorEvents(userA.id).at(-1)).toEqual(
        capture === "full" ? { capture: "full", statement: sql } : { capture: "none", statement: null },
      );
    }
  } finally {
    // The seeded value comes back, so later specs see the capture of a fresh installation.
    await setStudioSetting(platform, CAPTURE_KEY, previous);
  }
  expect(studioContainerId()).toBe(containerBefore);
});

test("MCP and agent endpoints answer 404 for user A", async () => {
  // Studio holds MCP and the agent off under governance until v1.1, and every agent route answers 404 to
  // a signed-in user. /api/mcp checks an MCP token before the hold, and while MCP is held Studio mints none, so A's
  // requests there end at the token: the mint answers 409 and /api/mcp 401.
  for (const [method, path, body] of [
    ["GET", "/api/agent/runs", undefined],
    ["POST", "/api/agent/runs", { connectionId: created().studioId, prompt: "List the orders" }],
    ["POST", "/api/agent/classify", { prompt: "List the orders" }],
  ] as const) {
    const answer = await studioRequest(studioA, path, { method, body });
    expect({ method, path, status: answer.status }).toEqual({ method, path, status: 404 });
  }
  const mint = await studioRequest(studioA, "/api/mcp/token", { method: "POST" });
  expect({ status: mint.status, error: (mint.body as ErrorBody).error }).toEqual({
    status: 409,
    error: "MCP tokens cannot be issued on this server",
  });
  // A same-origin GET carries no Origin header, as a request of an MCP client carries none.
  const mcp = await studioRequest(studioA, "/api/mcp");
  expect(mcp.status, JSON.stringify(mcp.body)).toBe(401);
});

test("revoke to 404 within 2 s", async () => {
  const { id, studioId } = created();
  await platform.goto(`/connections/${id}`);
  expect((await query(studioA, "SELECT 1")).status).toBe(200);

  const { answeredAt } = await revokeGrant(platform, userA.username);
  const latency = await latencyUntil(() => query(studioA, "SELECT 1"), 200, 404, answeredAt);
  report("revocation", latency);
  expect(latency).toBeLessThanOrEqual(REVOCATION_BOUND_MS);
  expect(errorOf(await query(studioA, "SELECT 1"))).toEqual({ status: 404, code: "CONNECTION_NOT_FOUND" });
  expect(await managedIds(studioA)).not.toContain(studioId);
  await grantRemoved(platform, userA.username);
});

test("session revocation to 401 within 2 s", async () => {
  expect((await studioRequest(studioA, "/api/connections/managed")).status).toBe(200);

  const { answeredAt } = await revokeStudioSessions(platform, userA.username, userA.id);
  const latency = await latencyUntil(() => studioRequest(studioA, "/api/connections/managed"), 200, 401, answeredAt);
  report("session revocation", latency);
  expect(latency).toBeLessThanOrEqual(REVOCATION_BOUND_MS);
  await expect(platform.getByRole("dialog")).toHaveCount(0);
});

test("logout hint", async () => {
  // The installer writes OIDC_LOGOUT_HINT=true only when release/release.config.json sets studio.logoutHintVerified,
  // which a passing run of this test allows. With the hint, Studio's logout sends Keycloak the ID token of the
  // session, and Keycloak ends that session without asking to confirm.
  const hint = studioEnvironment().get("OIDC_LOGOUT_HINT");
  const logout = await studioRequest(studioB, "/api/auth/logout", { method: "POST" });
  expect(logout.status, JSON.stringify(logout.body)).toBe(200);
  const redirectUrl = (logout.body as { redirectUrl?: string }).redirectUrl;
  if (redirectUrl === undefined) {
    throw new Error(`Studio's logout named no Keycloak logout URL: ${JSON.stringify(logout.body)}`);
  }
  const sentHint = new URL(redirectUrl).searchParams.has("id_token_hint");
  expect(sentHint, `the logout URL of a Studio with OIDC_LOGOUT_HINT=${hint}`).toBe(true);

  // Keycloak sends the browser back to Studio's /login, which sends a signed-out browser to Keycloak's sign-in form;
  // a logout that needed a confirmation stops on Keycloak's logout page instead.
  await studioB.goto(redirectUrl);
  await expect(studioB.locator("#username, #kc-logout")).toBeVisible();
  await expect(studioB.locator("#kc-logout"), "Keycloak asked to confirm the logout").toHaveCount(0);
  await expect(studioB).toHaveURL((url) => url.pathname.endsWith("/protocol/openid-connect/auth"));
  expect(keycloakSessions(userB.id)).toEqual([]);
});
