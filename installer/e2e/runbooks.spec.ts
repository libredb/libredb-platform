// The operations drill: against an installation that `apply` made from
// test/fixtures/configs/docker.yaml, it runs the fenced shell blocks of the seal key, installer client and break-glass
// runbooks under docs/runbooks/ as they are written, as root on the install host, and checks what each step promises.
// What a runbook leaves to a person, such as editing the configuration or entering a credential again in Platform, the
// spec does in between, as the runbook describes it. The last test checks that every shell block of the three runbooks
// ran.
//
// LIBREDB_E2E_ROOT is the command prefix that runs a command as root on the install host: `sudo` by default, or
// `docker exec -i <host>` for a Docker-in-Docker host. The blocks read LIBREDB_CONFIG, which the spec points at a copy
// of the applied configuration /opt/libredb/libredb.yaml that it edits, and USER_ID, the Keycloak id of a user.
// The tests run in order and share the installation, the connection and the sessions they build; the suite creates the
// target database container, a Keycloak user and the connection and removes them at the end. It signs in to Platform
// as the installer's first admin, whom platform-login.spec.ts signs in before it: the license that the end-to-end tests
// install has one admin seat, which the first admin then holds, so the first sign-in of another admin would be refused.
// The seal key drill expects its connection to be the only one, so the specs that run before it delete theirs.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { parse, stringify } from "yaml";
import { sealKeyId } from "../src/secrets/seal-keys";
import { createKeycloakUsers, deleteKeycloakUsers, type KeycloakUser } from "./fixtures/keycloak-users";
import { removeTargetDatabase, startTargetDatabase, type TargetDatabase } from "./fixtures/target-db";
import {
  createConnection,
  deleteConnection,
  FIRST_ADMIN,
  firstAdminTemporaryPassword,
  grantAccess,
  openConnection,
  signInFirstAdminToPlatform,
  type Credential,
} from "./helpers/platform";
import {
  docker,
  openStudioConsole,
  psqlAsSuperuser,
  signInToStudioAs,
  STUDIO_URL,
  studioRequest,
  type StudioAnswer,
} from "./helpers/studio";

test.describe.configure({ mode: "serial" });

const PLATFORM_URL = "https://platform.libredb.test";
const RUNBOOKS = fileURLToPath(new URL("../docs/runbooks/", import.meta.url));
const PLATFORM_RUNTIME_DOC = fileURLToPath(new URL("../../docs/deploy/platform-runtime.md", import.meta.url));
const DB_SHELL_SOURCE = fileURLToPath(new URL("../src/cli/commands/db-shell.ts", import.meta.url));
/** The runbooks whose shell blocks the drill runs. */
const DRILLED = ["seal-key-rotation.md", "installer-client.md", "break-glass.md"] as const;
type Runbook = (typeof DRILLED)[number];

const APPLIED_CONFIG = "/opt/libredb/libredb.yaml";
/** The configuration the runbook blocks apply, a copy of the applied one that the spec edits. */
const CONFIG = "/root/libredb-runbooks-e2e.yaml";
const PLATFORM_CONTAINER = "libredb-platform-1";
const KEYCLOAK_TOKEN_URL = "http://127.0.0.1:18080/realms/libredb/protocol/openid-connect/token";
const POLL_INTERVAL_MS = 100;
const REVOCATION_BOUND_MS = 2_000;
const LATENCY_LIMIT_MS = 15_000;
/** Studio beats every 30 s, so a heartbeat condition gets a few beats. */
const HEARTBEAT_WAIT_MS = 120_000;

interface ShellResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a bash script as root on the install host, through LIBREDB_E2E_ROOT, with `env` and `input` on stdin. */
function asRoot(script: string, env: Record<string, string> = {}, input = ""): ShellResult {
  const [binary, ...prefix] = (process.env.LIBREDB_E2E_ROOT ?? "sudo").split(/\s+/).filter(Boolean);
  const variables = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  const result = spawnSync(binary as string, [...prefix, "env", ...variables, "bash", "-c", script], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Like asRoot, and throws with the output when the script exits non-zero. */
function asRootOk(script: string, env: Record<string, string> = {}, input = ""): string {
  const result = asRoot(script, env, input);
  if (result.status !== 0) {
    throw new Error(`exit ${result.status} from ${script.split("\n")[0]}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** The fenced shell blocks of a runbook, in document order. */
function shellBlocks(runbook: string): string[] {
  const text = readFileSync(`${RUNBOOKS}${runbook}`, "utf8");
  return [...text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((match) => match[1] as string);
}

/** The blocks this run executed, as `<runbook>#<index>`. */
const executed = new Set<string>();

/**
 * Runs block `index` of `runbook` as written, as root with LIBREDB_CONFIG and `env`, after checking that it is the
 * block the step expects: it contains `expected`.
 */
function runBlock(runbook: Runbook, index: number, expected: string, env: Record<string, string> = {}): ShellResult {
  const block = shellBlocks(runbook)[index];
  if (block === undefined) throw new Error(`${runbook} has no shell block ${index}`);
  expect(block, `shell block ${index} of ${runbook}`).toContain(expected);
  executed.add(`${runbook}#${index}`);
  const result = asRoot(block, { LIBREDB_CONFIG: CONFIG, ...env });
  console.log(`${runbook} block ${index} exited ${result.status}`);
  return result;
}

function expectSuccess(result: ShellResult): string {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

/** Sets bridge.sealKeys in the configuration the blocks apply, as the runbook asks the operator to. */
function editSealKeys(sealKeys: Record<string, unknown>): void {
  const config = parse(asRootOk(`cat ${CONFIG}`)) as Record<string, unknown>;
  config.bridge = { sealKeys };
  asRootOk(`umask 077 && cat > ${CONFIG}`, {}, stringify(config));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sends `request` every 100 ms until it answers `expected`, and returns how long after `since` that answer arrived. */
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
      throw new Error(`Studio still answered ${answer.status} ${arrivedAt - since} ms after the statement`);
    }
    await sleep(Math.max(0, sentAt + POLL_INTERVAL_MS - Date.now()));
  }
}

function report(what: string, latencyMs: number): void {
  console.log(`${what} latency: ${latencyMs} ms`);
  test.info().annotations.push({ type: `${what} latency`, description: `${latencyMs} ms` });
}

interface Heartbeat {
  instance: string;
  kids: string[];
  canary: Record<string, string>;
}

/** The live heartbeats of bridge.studio_instance, as the runbook's query reads them. */
function heartbeats(): Heartbeat[] {
  return JSON.parse(
    psqlAsSuperuser(
      "libredb",
      `SELECT coalesce(json_agg(json_build_object('instance', instance_id, 'kids', keyring_kids, 'canary', canary)
         ORDER BY instance_id), '[]') FROM bridge.studio_instance WHERE last_seen_at > now() - interval '2 minutes'`,
    ),
  ) as Heartbeat[];
}

/** The kids of the connection's read and write envelopes. */
function envelopeKids(connectionId: string): { read: string; write: string } {
  return JSON.parse(
    psqlAsSuperuser(
      "libredb",
      `SELECT json_build_object('read', split_part(read_secret, '.', 2), 'write', split_part(write_secret, '.', 2))
         FROM bridge.connections_v1 WHERE connection_id = '${connectionId}'`,
    ),
  ) as { read: string; write: string };
}

function canaryKids(): string[] {
  return JSON.parse(
    psqlAsSuperuser("libredb", "SELECT coalesce(json_agg(kid ORDER BY kid), '[]') FROM bridge.seal_canary_v1"),
  ) as string[];
}

/** The kid of BRIDGE_SEAL_PUBLIC_KEY in the running Platform container. */
function platformKid(): string {
  const entries = JSON.parse(docker(["inspect", "--format", "{{json .Config.Env}}", PLATFORM_CONTAINER])) as string[];
  const entry = entries.find((candidate) => candidate.startsWith("BRIDGE_SEAL_PUBLIC_KEY="));
  if (entry === undefined) throw new Error(`${PLATFORM_CONTAINER} has no BRIDGE_SEAL_PUBLIC_KEY`);
  return sealKeyId(entry.slice(entry.indexOf("=") + 1));
}

/** The secret of libredb-installer in installer.env. */
function installerSecret(): string {
  return asRootOk('. /opt/libredb/secrets/installer.env && printf %s "$KEYCLOAK_INSTALLER_CLIENT_SECRET"');
}

/** The HTTP status of a libredb-installer token request with `secret`, sent on stdin from the install host. */
function installerTokenStatus(secret: string): string {
  return asRootOk(
    "curl -s -o /dev/null -w '%{http_code}' --data-urlencode grant_type=client_credentials " +
      `--data-urlencode client_id=libredb-installer --data-urlencode client_secret@- ${KEYCLOAK_TOKEN_URL}`,
    {},
    secret,
  );
}

let target: TargetDatabase;
let user: KeycloakUser;
let adminContext: BrowserContext;
let userContext: BrowserContext;
let platform: Page;
let studio: Page;
let connection: { id: string; name: string };

function query(sql = "SELECT 1"): Promise<StudioAnswer> {
  return studioRequest(studio, "/api/db/query", { body: { connectionId: `seed:${connection.id}`, sql } });
}

/** Waits until the granted user's query answers 200 again, as it must after every rotation step. */
async function userStillQueries(): Promise<void> {
  await expect
    .poll(async () => (await query()).status, { timeout: 60_000, intervals: [500] })
    .toBe(200);
}

/** Enters the connection's read and write credentials again in Platform's edit form (seal key runbook step 4). */
async function reenterCredentials(read: Credential, write: Credential): Promise<void> {
  await platform.goto(`/connections/${connection.id}`);
  const readGroup = platform.getByRole("group", { name: "Read credential" });
  await readGroup.getByLabel("User", { exact: true }).fill(read.user);
  await readGroup.getByLabel("Password", { exact: true }).fill(read.password);
  await platform.getByLabel(/I confirm that the read credential can only read/).check();
  await platform.getByLabel("Write credential", { exact: true }).selectOption("set");
  const writeGroup = platform.getByRole("group", { name: "New write credential" });
  await writeGroup.getByLabel("User", { exact: true }).fill(write.user);
  await writeGroup.getByLabel("Password", { exact: true }).fill(write.password);
  await platform.getByRole("button", { name: "Save changes" }).click();
}

test.beforeAll(async ({ browser }) => {
  target = await startTargetDatabase();
  [user] = createKeycloakUsers(["runbook-user"], "user") as [KeycloakUser];
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

  const name = `Runbook ${Date.now().toString(36)}`;
  await createConnection(platform, {
    name,
    host: target.host,
    port: target.port,
    database: target.database,
    read: target.read,
    write: target.write,
  });
  connection = { id: await openConnection(platform, name), name };
  await grantAccess(platform, user.username, "read");

  studio = await userContext.newPage();
  await signInToStudioAs(studio, user);
  await openStudioConsole(studio);
  await userStillQueries();

  asRootOk(`umask 077 && cp ${APPLIED_CONFIG} ${CONFIG}`);
});

test.afterAll(async () => {
  try {
    if (connection !== undefined) await deleteConnection(platform, connection);
  } finally {
    for (const context of [adminContext, userContext]) await context?.close();
    removeTargetDatabase();
    if (user !== undefined) deleteKeycloakUsers([user.id]);
    asRoot(`rm -f ${CONFIG}`);
  }
});

test("seal-key rotation: every heartbeat lists the new kid, its canary is ok after the switch, no envelope uses the old kid after re-entry, and the granted user still queries", async () => {
  test.setTimeout(30 * 60_000);
  const runbook = "seal-key-rotation.md";
  const oldKid = envelopeKids(connection.id).read;
  expect(envelopeKids(connection.id)).toEqual({ read: oldKid, write: oldKid });
  expect(platformKid()).toBe(oldKid);
  // An earlier test of the installation may have left other kids in the keyring and canaries, so the spec compares
  // with what it finds rather than with an exact set.
  const kidsBefore = new Set(heartbeats().flatMap((row) => row.kids));
  const canariesBefore = canaryKids();

  // Before you start: the heartbeats and the connections per kid.
  expect(expectSuccess(runBlock(runbook, 0, "bridge.studio_instance"))).toContain(oldKid);
  const before = expectSuccess(runBlock(runbook, 1, "bridge.connections_v1"));
  expect(before).toContain(`${oldKid}|read|${connection.id}`);
  expect(before).toContain(`${oldKid}|write|${connection.id}`);

  // 1. Add the new key to Studio.
  editSealKeys({ issueNew: true });
  expectSuccess(runBlock(runbook, 2, "apply"));

  // 2. Every heartbeat lists the new kid and still reports ok for the old one.
  let newKid = "";
  await expect
    .poll(
      () => {
        const live = heartbeats();
        const added = live[0]?.kids.filter((kid) => !kidsBefore.has(kid)) ?? [];
        newKid = added.length === 1 ? (added[0] as string) : "";
        return (
          newKid !== "" &&
          live.every((row) => row.kids.includes(oldKid) && row.kids.includes(newKid) && row.canary[oldKid] === "ok")
        );
      },
      { timeout: HEARTBEAT_WAIT_MS, intervals: [2_000] },
    )
    .toBe(true);
  expect(expectSuccess(runBlock(runbook, 3, "bridge.studio_instance"))).toContain(newKid);
  expect(platformKid()).toBe(oldKid);
  await userStillQueries();

  // 3. Switch Platform to the new key; apply's verify waits for the canary, and the heartbeats confirm it.
  editSealKeys({ issueNew: false, activeKid: newKid });
  expectSuccess(runBlock(runbook, 4, "apply"));
  expect(platformKid()).toBe(newKid);
  await expect
    .poll(() => heartbeats().every((row) => row.canary[newKid] === "ok" && row.canary[oldKid] === "ok"), {
      timeout: HEARTBEAT_WAIT_MS,
      intervals: [2_000],
    })
    .toBe(true);
  expect(canaryKids()).toEqual([...new Set([...canariesBefore, newKid])].sort());
  await userStillQueries();

  // Step 5 before step 4: apply refuses with exit 6, naming the connection, and changes nothing.
  editSealKeys({ issueNew: false, activeKid: newKid, retire: [oldKid] });
  const refused = runBlock(runbook, 6, "apply");
  expect(refused.status, `${refused.stdout}\n${refused.stderr}`).toBe(6);
  expect(`${refused.stdout}${refused.stderr}`).toContain(`${connection.name} (${connection.id})`);
  expect(canaryKids()).toContain(oldKid);

  // 4. Platform warns about the credentials sealed to the old kid; the admin enters them again.
  editSealKeys({ issueNew: false, activeKid: newKid });
  await platform.goto(`/connections/${connection.id}`);
  await expect(platform.getByRole("alert").filter({ hasText: "sealed to an earlier Studio key" })).toContainText(oldKid);
  await reenterCredentials(target.read, target.write as Credential);
  await expect
    .poll(() => envelopeKids(connection.id), { timeout: 30_000, intervals: [500] })
    .toEqual({ read: newKid, write: newKid });
  const after = expectSuccess(runBlock(runbook, 5, "bridge.connections_v1"));
  expect(after).not.toContain(oldKid);
  expect(after).toContain(`${newKid}|read|${connection.id}`);
  await userStillQueries();

  // 5. Retire the old key: its canary row goes in the same apply, and Studio's keyring holds the new key alone.
  editSealKeys({ issueNew: false, activeKid: newKid, retire: [oldKid] });
  expectSuccess(runBlock(runbook, 6, "apply"));
  expect(canaryKids()).not.toContain(oldKid);
  expect(canaryKids()).toContain(newKid);
  await expect
    .poll(
      () =>
        heartbeats().map((row) => ({
          old: row.kids.includes(oldKid) || oldKid in row.canary,
          current: row.kids.includes(newKid) ? row.canary[newKid] : "missing",
        })),
      { timeout: HEARTBEAT_WAIT_MS, intervals: [2_000] },
    )
    .toEqual([{ old: false, current: "ok" }]);
  expect(platformKid()).toBe(newKid);
  await userStillQueries();
});

test("installer client rotation: apply authenticates with the new secret and the old secret gets 401", async () => {
  test.setTimeout(15 * 60_000);
  const runbook = "installer-client.md";
  const oldSecret = installerSecret();
  expect(installerTokenStatus(oldSecret)).toBe("200");

  expectSuccess(runBlock(runbook, 0, "/client-secret"));
  const newSecret = installerSecret();
  expect(newSecret).not.toBe(oldSecret);
  expect(asRootOk("stat -c '%a %U' /opt/libredb/secrets/installer.env").trim()).toBe("600 root");
  expect(installerTokenStatus(oldSecret)).toBe("401");
  expect(installerTokenStatus(newSecret)).toBe("200");

  const applied = runBlock(runbook, 1, "apply");
  expectSuccess(applied);
  // A full apply that reached the keycloak-configure step authenticated as libredb-installer with the new secret.
  expect(applied.stdout).toContain("verify:");
});

test("break-glass: the runbook follows Platform's runtime page and the db-shell of the installer", () => {
  const runbook = readFileSync(`${RUNBOOKS}break-glass.md`, "utf8");
  const page = readFileSync(PLATFORM_RUNTIME_DOC, "utf8");
  const usage = /Usage: (libredb-installer db-shell --as platform) \[-c <sql>\]/.exec(readFileSync(DB_SHELL_SOURCE, "utf8"));
  expect(usage, "db-shell's usage line").not.toBeNull();
  const command = (usage as RegExpExecArray)[1] as string;
  expect(page).toContain(`\`${command}\` opens such a session on the installation's data network`);
  expect(runbook).toContain(`\`${command}\` opens such a session in a one-shot container on the installation's data network`);
  // The two break-glass statements, verbatim in Platform's page and in the runbook, and run with the user's id.
  const blocks = shellBlocks("break-glass.md");
  for (const statement of [
    "DELETE FROM platform.connection_grants WHERE subject = '<id>'",
    "INSERT INTO platform.session_revocations (subject, reason) VALUES ('<id>', 'admin')",
  ]) {
    expect(page).toContain(`${statement};`);
    expect(runbook).toContain(`${statement};`);
    const run = `/opt/libredb/bin/${command} -c "${statement.replace("<id>", "$USER_ID")}"`;
    expect(blocks.some((block) => block.trim() === run), run).toBe(true);
  }
});

test("break-glass: the documented grant DELETE through db-shell --as platform makes Studio answer 404 within 2 s", async () => {
  const runbook = "break-glass.md";
  expect(expectSuccess(runBlock(runbook, 0, "platform.connection_grants"))).toContain(user.id);
  expect((await query()).status).toBe(200);

  const result = runBlock(runbook, 1, "DELETE FROM platform.connection_grants", { USER_ID: user.id });
  const answeredAt = Date.now();
  expectSuccess(result);
  const latency = await latencyUntil(() => query(), 200, 404, answeredAt);
  report("break-glass revocation", latency);
  expect(latency).toBeLessThanOrEqual(REVOCATION_BOUND_MS);
});

test("break-glass: the documented revocation INSERT through db-shell --as platform makes the user's next Studio request answer 401 within 2 s", async () => {
  const runbook = "break-glass.md";
  expect((await studioRequest(studio, "/api/connections/managed")).status).toBe(200);

  const result = runBlock(runbook, 2, "INSERT INTO platform.session_revocations", { USER_ID: user.id });
  const answeredAt = Date.now();
  expectSuccess(result);
  const latency = await latencyUntil(() => studioRequest(studio, "/api/connections/managed"), 200, 401, answeredAt);
  report("break-glass session revocation", latency);
  expect(latency).toBeLessThanOrEqual(REVOCATION_BOUND_MS);
});

test("break-glass: the kill switch stops Studio, start brings it back, and status shows every container", async () => {
  test.setTimeout(5 * 60_000);
  const runbook = "break-glass.md";
  const probe = await adminContext.newPage();
  const ready = async () => (await probe.goto(`${STUDIO_URL}/api/ready`))?.status() ?? 0;
  expect(await ready()).toBe(200);

  expectSuccess(runBlock(runbook, 3, "stop studio"));
  expect(await ready()).toBe(502);

  expectSuccess(runBlock(runbook, 4, "start studio"));
  await expect.poll(ready, { timeout: 120_000, intervals: [2_000] }).toBe(200);

  const status = expectSuccess(runBlock(runbook, 5, "status"));
  for (const service of ["postgres", "keycloak", "platform", "studio", "edge"]) expect(status).toContain(service);
  await probe.close();
});

test("the drill ran every shell block of the three runbooks", () => {
  const total = DRILLED.reduce((sum, runbook) => sum + shellBlocks(runbook).length, 0);
  expect([...executed].sort()).toEqual(
    DRILLED.flatMap((runbook) => shellBlocks(runbook).map((_, index) => `${runbook}#${index}`)).sort(),
  );
  expect(executed.size).toBe(total);
});
