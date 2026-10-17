// Studio in Docker mode end to end: the compiled installer applies the whole installation as root under /opt/libredb
// in the Compose project libredb, and verify proves Studio ready, beating, opening Platform's canary, receiving change
// notifications and signing in through Keycloak, with the edge refusing raw paths that Keycloak could resolve another
// way. It needs a disposable Linux host with Docker, because it removes any earlier install first.
// LIBREDB_INSTALLER_BIN names another installer binary than dist/libredb-installer-linux-x64, and
// LIBREDB_E2E_IMAGES_REGISTRY sets images.registry for every run, such as registry.example.com/libredb for images
// that exist only in a registry mirror.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:tls";
import { parseComposePs, type ComposeContainer } from "../../src/adapters/docker";
import { generateSealKeyPair } from "../../src/secrets/seal-keys";
import { CATALOGUE } from "../../src/verify/catalogue";

const packageRoot = join(import.meta.dir, "..", "..");
const INSTALLER = process.env.LIBREDB_INSTALLER_BIN ?? join(packageRoot, "dist", "libredb-installer-linux-x64");
const CONFIG = join(packageRoot, "test", "fixtures", "configs", "docker.yaml");
const REGISTRY = process.env.LIBREDB_E2E_IMAGES_REGISTRY;
const CONFIG_ARGS = ["-c", CONFIG, ...(REGISTRY === undefined || REGISTRY === "" ? [] : ["--set", `images.registry=${REGISTRY}`])];
const INSTALL_ROOT = "/opt/libredb";
const PROJECT = "libredb";
const COMPOSE_FILE = join(INSTALL_ROOT, "compose.yaml");
const PLATFORM_ENV = join(INSTALL_ROOT, "env", "platform.env");
const CA_BUNDLE = join(INSTALL_ROOT, "ca", "ca.crt");
const AUTH_HOST = "auth.libredb.test";
const LONG = 15 * 60_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Report {
  checks: { id: string; result: string; cause: string | null }[];
}

// Everything the installer printed during this file, which must never hold a generated secret.
const printed: string[] = [];

function sh(argv: string[], check = true): RunResult {
  const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`${argv.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

/** Runs the installer with stdin on /dev/null, so it never sees a terminal. */
async function installer(...args: string[]): Promise<RunResult> {
  const child = Bun.spawn([INSTALLER, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  printed.push(stdout, stderr);
  return { code, stdout, stderr };
}

async function verifyJson(...extra: string[]): Promise<{ code: number; report: Report; stderr: string }> {
  const run = await installer("verify", ...CONFIG_ARGS, ...extra, "--output", "json");
  return { code: run.code, report: JSON.parse(run.stdout) as Report, stderr: run.stderr };
}

const failedChecks = (report: Report) => report.checks.filter((check) => check.result === "failed");

function containers(): ComposeContainer[] {
  return parseComposePs(sh(["docker", "compose", "-p", PROJECT, "ps", "--all", "--format", "json"]).stdout);
}

function container(service: string): ComposeContainer {
  const found = containers().find((candidate) => candidate.service === service);
  if (found === undefined) throw new Error(`the project has no ${service} container`);
  return found;
}

/** Runs SQL in database libredb as the superuser, over the server's local socket inside its own container. */
function psqlAsSuperuser(sql: string): string {
  const script = 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d libredb -c "$1"';
  return sh(["docker", "exec", `${PROJECT}-postgres-1`, "sh", "-c", script, "sh", sql]).stdout.trim();
}

async function waitFor(what: string, timeoutMs: number, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs / 1000} s`);
    await Bun.sleep(2_000);
  }
}

/**
 * Sends `GET <path>` to the edge exactly as written, over TLS to the auth hostname, and returns the status code.
 * fetch would normalize `..` and percent-encoded dots, so the request goes through a raw TLS socket.
 */
function rawGet(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 443, servername: AUTH_HOST, ca: readFileSync(CA_BUNDLE) }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${AUTH_HOST}\r\nConnection: close\r\n\r\n`);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
      if (match === null) reject(new Error(`no status line in the answer to ${path}`));
      else resolve(Number(match[1]));
    });
  });
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function removeEarlierInstall(): void {
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

beforeAll(() => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("the Docker end-to-end tests need root on a disposable Linux host with Docker");
  }
  if (!existsSync(INSTALLER)) throw new Error(`${INSTALLER} does not exist; run bun run build first`);
  removeEarlierInstall();
});

describe("Studio in Docker mode", () => {
  test(
    "apply then verify passes every check in the catalogue",
    async () => {
      const applied = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: "" });
      // A full apply ends with the verify and report steps.
      expect(applied.stdout).toContain("LibreDB is installed and every verify check passed.");
      for (const line of [
        "  Platform  https://platform.libredb.test",
        "  Studio    https://studio.libredb.test",
        "  Auth      https://auth.libredb.test",
        `CA bundle: ${CA_BUNDLE}`,
        `${INSTALL_ROOT}/secrets/first-admin.txt`,
        `${INSTALL_ROOT}/secrets/user-manager.txt`,
      ]) {
        expect(applied.stdout).toContain(line);
      }

      const verify = await verifyJson();
      expect(verify.report.checks.map((check) => check.id)).toEqual(CATALOGUE.map((check) => check.id));
      expect(failedChecks(verify.report)).toEqual([]);
      expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });
    },
    LONG,
  );

  test(
    "through the edge, raw paths /realms/libredb/..;/master/, /realms/libredb/%2e%2e/master/ and /realms/libredb/..%2f..%2fadmin/ answer 400, and the realm discovery document answers 200",
    async () => {
      for (const path of ["/realms/libredb/..;/master/", "/realms/libredb/%2e%2e/master/", "/realms/libredb/..%2f..%2fadmin/"]) {
        expect({ path, status: await rawGet(path) }).toEqual({ path, status: 400 });
      }
      expect(await rawGet("/realms/libredb/.well-known/openid-configuration")).toBe(200);
      expect(await rawGet("/realms/master/")).toBe(404);
    },
    LONG,
  );

  test(
    "with network.httpsProxy pointing at a closed port, oidc-discovery-in-network and studio-oidc-chain still pass",
    async () => {
      // Port 9 of the loopback interface of every container is closed, so any request the apps sent through the
      // proxy would fail; NO_PROXY must keep the issuer off it.
      const proxy = ["--set", "network.httpsProxy=http://127.0.0.1:9"];
      const applied = await installer("apply", ...CONFIG_ARGS, ...proxy, "--yes");
      expect(applied.stderr).toBe("");
      expect(applied.stdout).toContain("recreate studio with its changed env file");
      const verify = await verifyJson(...proxy);
      for (const id of ["oidc-discovery-in-network", "studio-oidc-chain", "no-proxy"]) {
        expect(verify.report.checks.find((check) => check.id === id)).toEqual({ id, result: "passed", cause: null });
      }
      expect(readFileSync(join(INSTALL_ROOT, "env", "studio.env"), "utf8")).toContain("HTTPS_PROXY=http://127.0.0.1:9\n");

      const restored = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect({ code: restored.code, stderr: restored.stderr }).toEqual({ code: 0, stderr: "" });
      expect(readFileSync(join(INSTALL_ROOT, "env", "studio.env"), "utf8")).not.toContain("HTTPS_PROXY");
    },
    LONG,
  );

  test(
    "after the studio container is force-recreated, bridge.studio_instances_v1 holds one row, libredb-studio, which keeps its started_at and whose last_seen_at advances",
    async () => {
      // The heartbeat upsert never changes started_at, so the recreated container updates the same row, and only
      // last_seen_at shows that the new process beats.
      const epoch = (column: string) => Number(psqlAsSuperuser(`SELECT extract(epoch FROM ${column}) FROM bridge.studio_instance`));
      const startedBefore = epoch("started_at");
      const id = container("studio").id;

      sh(["docker", "compose", "-p", PROJECT, "-f", COMPOSE_FILE, "up", "-d", "--force-recreate", "--wait", "studio"]);
      expect(container("studio").id).not.toBe(id);
      const recreatedAt = Number(psqlAsSuperuser("SELECT extract(epoch FROM now())"));

      await waitFor("a heartbeat of the recreated Studio", 90_000, () => epoch("last_seen_at") > recreatedAt);
      const first = epoch("last_seen_at");
      await waitFor("the next heartbeat", 45_000, () => epoch("last_seen_at") > first);
      expect(psqlAsSuperuser("SELECT string_agg(instance_id, ',') FROM bridge.studio_instance")).toBe("libredb-studio");
      expect(epoch("started_at")).toBe(startedBefore);
    },
    LONG,
  );

  test(
    "after BRIDGE_SEAL_PUBLIC_KEY in platform.env is replaced and Platform recreated, verify exits 4 naming studio-canary, and the next apply restores the key",
    async () => {
      const original = readFileSync(PLATFORM_ENV, "utf8");
      const other = generateSealKeyPair().publicKey;
      const replaced = original.replace(/^BRIDGE_SEAL_PUBLIC_KEY=.*$/m, `BRIDGE_SEAL_PUBLIC_KEY=${other}`);
      expect(replaced).not.toBe(original);
      writeFileSync(PLATFORM_ENV, replaced, { mode: 0o600 });
      sh(["docker", "compose", "-p", PROJECT, "-f", COMPOSE_FILE, "up", "-d", "--force-recreate", "--wait", "platform"]);

      const broken = await verifyJson();
      expect(broken.code).toBe(4);
      expect(failedChecks(broken.report).map((check) => check.id)).toContain("studio-canary");
      expect(broken.report.checks.find((check) => check.id === "studio-canary")?.cause).toContain("UNKNOWN_KID");

      const restored = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect({ code: restored.code, stderr: restored.stderr }).toEqual({ code: 0, stderr: "" });
      expect(readFileSync(PLATFORM_ENV, "utf8")).toBe(original);
      const verify = await verifyJson();
      expect(failedChecks(verify.report)).toEqual([]);
      expect(verify.code).toBe(0);
    },
    LONG,
  );

  test(
    "no generated secret or seal private key appears in the report or any other command output",
    () => {
      const store = JSON.parse(readFileSync(join(INSTALL_ROOT, "secrets", "secrets.json"), "utf8")) as {
        values: Record<string, string>;
        sealKeys: { privateKey: string }[];
      };
      const passwords = ["first-admin.txt", "user-manager.txt"].map((name) =>
        readFileSync(join(INSTALL_ROOT, "secrets", name), "utf8").trim(),
      );
      const secrets = [...Object.values(store.values), ...store.sealKeys.map((key) => key.privateKey), ...passwords];
      expect(secrets.length).toBeGreaterThan(5);
      const output = printed.join("\n");
      expect(output).toContain("Next steps:");
      const logs = filesUnder(join(INSTALL_ROOT, "logs")).map((path) => readFileSync(path, "utf8"));
      for (const [index, secret] of secrets.entries()) {
        expect({ secret: index, found: output.includes(secret) }).toEqual({ secret: index, found: false });
        expect({ secret: index, found: logs.some((log) => log.includes(secret)) }).toEqual({ secret: index, found: false });
      }
    },
    LONG,
  );
});
