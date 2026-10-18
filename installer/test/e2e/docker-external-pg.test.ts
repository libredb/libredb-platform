// Docker mode with an external PostgreSQL end to end: a PostgreSQL server outside the Compose project, serving TLS
// from a test CA for pg.libredb.test, holds an admin role with CREATEROLE and CREATEDB whose password the first apply
// reads from LIBREDB_PG_ADMIN_PASSWORD. The second apply runs without that variable and without a terminal, as the
// certificate renewal timer does, so the steps that need the admin role skip with a note.
// The server resolves as pg.libredb.test the way a site's DNS name would: the test creates the network libredb_data
// with the labels the base step adopts, and the server joins it under that alias, so every container of the
// installation and every psql container of the installer reaches it by name.
// It needs a disposable Linux host with Docker, because it removes any earlier install first.
// LIBREDB_INSTALLER_BIN names another installer binary than dist/libredb-installer-linux-x64, LIBREDB_E2E_IMAGES_REGISTRY
// sets images.registry for every run, such as registry.example.com/libredb, and the external server runs the release's
// PostgreSQL image from that registry.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { parseComposePs } from "../../src/adapters/docker";
import { embeddedRelease } from "../../src/cli/release";
import { imageReference } from "../../src/release/images";
import { renderPgHba } from "../../src/render/compose";
import { generateSecret } from "../../src/secrets/generate";
import { scramSha256Verifier } from "../../src/secrets/scram";
import { createCa } from "../../src/tls/ca";
import { issueLeaf } from "../../src/tls/leaf";
import { CATALOGUE } from "../../src/verify/catalogue";
import { LICENSE_ARGS } from "./support/install";

const packageRoot = join(import.meta.dir, "..", "..");
const INSTALLER = process.env.LIBREDB_INSTALLER_BIN ?? join(packageRoot, "dist", "libredb-installer-linux-x64");
const CONFIG = join(packageRoot, "test", "fixtures", "configs", "docker.yaml");
const REGISTRY = process.env.LIBREDB_E2E_IMAGES_REGISTRY;
const REGISTRY_ARGS = REGISTRY === undefined || REGISTRY === "" ? [] : ["--set", `images.registry=${REGISTRY}`];
const SERVER_IMAGE = imageReference(embeddedRelease().images.postgres, REGISTRY === "" ? undefined : REGISTRY);
const EXTERNAL = "libredb-e2e-external-pg";
const SERVER_HOST = "pg.libredb.test";
const DATA_NETWORK = "libredb_data";
const ADMIN_USER = "corp_dba";
const ADMIN_ENV = "LIBREDB_PG_ADMIN_PASSWORD";
const INSTALL_ROOT = "/opt/libredb";
const PROJECT = "libredb";
const LONG = 20 * 60_000;

const scratch = mkdtempSync(join(tmpdir(), "libredb-e2e-external-pg-"));
// The files the server container reads, in a directory its postgres user may enter.
const serverFiles = join(scratch, "server");
const superuserPassword = generateSecret();
// The admin password a run sets in LIBREDB_PG_ADMIN_PASSWORD, so `grep -rF "$LIBREDB_PG_ADMIN_PASSWORD" /opt/libredb`
// can check the host afterwards, or a fresh one.
const adminPassword = process.env.LIBREDB_PG_ADMIN_PASSWORD || generateSecret();

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Report {
  checks: { id: string; result: string; cause: string | null }[];
}

// Everything the installer printed during this file, which must never hold the admin password.
const printed: string[] = [];

function sh(argv: string[], check = true): RunResult {
  const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`${argv.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

/** The configuration of the external server, as --set overrides of the Docker fixture. */
function configArgs(): string[] {
  const sets = [
    "postgres.mode=external",
    `postgres.external.host=${SERVER_HOST}`,
    `postgres.external.adminUser=${ADMIN_USER}`,
    `postgres.external.adminPasswordEnv=${ADMIN_ENV}`,
    `postgres.external.caBundleFile=${join(scratch, "corp-db-ca.crt")}`,
  ];
  return ["-c", CONFIG, ...REGISTRY_ARGS, ...LICENSE_ARGS, ...sets.flatMap((set) => ["--set", set])];
}

/** Runs the installer with stdin on /dev/null, so it never sees a terminal, and the admin password only when given. */
async function installer(args: string[], withAdminPassword: boolean): Promise<RunResult> {
  const { [ADMIN_ENV]: _inherited, ...inherited } = process.env;
  const env = withAdminPassword ? { ...inherited, [ADMIN_ENV]: adminPassword } : inherited;
  const child = Bun.spawn([INSTALLER, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  printed.push(stdout, stderr);
  return { code, stdout, stderr };
}

/** Runs SQL as the external server's superuser over its local socket, inside its own container. */
function psqlAsSuperuser(sql: string, database = "postgres"): string {
  const script = 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d "$2" -c "$1"';
  return sh(["docker", "exec", EXTERNAL, "sh", "-c", script, "sh", sql, database]).stdout.trim();
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function removeEarlierInstall(): void {
  // The server first, because it holds an endpoint on the project's network.
  sh(["docker", "rm", "--force", "--volumes", EXTERNAL], false);
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

beforeAll(async () => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("the Docker end-to-end tests need root on a disposable Linux host with Docker");
  }
  if (!existsSync(INSTALLER)) throw new Error(`${INSTALLER} does not exist; run bun run build first`);
  removeEarlierInstall();

  // The customer's database team signs the server certificate for the name the installation reaches it by.
  const now = new Date();
  const corpCa = await createCa({ commonName: "LibreDB e2e corp database CA", now });
  const leaf = await issueLeaf(corpCa, [SERVER_HOST], now);
  writeFileSync(join(scratch, "corp-db-ca.crt"), corpCa.certPem, { mode: 0o644 });
  mkdirSync(serverFiles, { mode: 0o755 });
  chmodSync(serverFiles, 0o755);
  writeFileSync(join(serverFiles, "server.crt"), leaf.certPem, { mode: 0o644 });
  // A throwaway test key, copied into the server container with mode 0600 at start.
  writeFileSync(join(serverFiles, "server.key"), leaf.keyPem, { mode: 0o644 });
  writeFileSync(join(serverFiles, "pg_hba.conf"), renderPgHba(), { mode: 0o644 });
  writeFileSync(
    join(scratch, "server.env"),
    `POSTGRES_PASSWORD=${superuserPassword}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256\n`,
    { mode: 0o600 },
  );
  // The network as the base step creates it, which base then adopts, with the server under its DNS name.
  sh(["docker", "network", "create", "--driver", "bridge", "--label", `com.docker.compose.project=${PROJECT}`,
    "--label", "com.docker.compose.network=data", DATA_NETWORK]);
  sh([
    "docker",
    "run",
    "--detach",
    "--name",
    EXTERNAL,
    "--network",
    DATA_NETWORK,
    "--network-alias",
    SERVER_HOST,
    "--env-file",
    join(scratch, "server.env"),
    "--volume",
    `${serverFiles}:/etc/libredb-e2e/source:ro`,
    "--entrypoint",
    "sh",
    SERVER_IMAGE,
    "-c",
    [
      "install -d -m 0700 -o postgres -g postgres /etc/libredb-e2e/tls",
      "install -m 0600 -o postgres -g postgres /etc/libredb-e2e/source/server.key /etc/libredb-e2e/tls/server.key",
      "install -m 0644 -o postgres -g postgres /etc/libredb-e2e/source/server.crt /etc/libredb-e2e/tls/server.crt",
      "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/libredb-e2e/tls/server.crt " +
        "-c ssl_key_file=/etc/libredb-e2e/tls/server.key -c hba_file=/etc/libredb-e2e/source/pg_hba.conf " +
        "-c password_encryption=scram-sha-256 -c log_statement=all",
    ].join(" && "),
  ]);
  const deadline = Date.now() + 180_000;
  while (sh(["docker", "exec", EXTERNAL, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], false).code !== 0) {
    if (Date.now() > deadline) throw new Error(`${EXTERNAL} did not become ready within 180 s`);
    await Bun.sleep(1_000);
  }
  // The admin role a managed PostgreSQL service hands over: CREATEROLE and CREATEDB, no SUPERUSER.
  const verifier = scramSha256Verifier(adminPassword, crypto.getRandomValues(new Uint8Array(16)));
  psqlAsSuperuser(`CREATE ROLE ${ADMIN_USER} LOGIN PASSWORD '${verifier}' CREATEROLE CREATEDB`);
}, LONG);

afterAll(() => {
  sh(["docker", "rm", "--force", "--volumes", EXTERNAL], false);
  rmSync(scratch, { recursive: true, force: true });
});

describe("Docker mode with an external PostgreSQL", () => {
  test(
    "Docker mode with an external PostgreSQL converges twice and passes verify",
    async () => {
      const first = await installer(["apply", ...configArgs(), "--yes"], true);
      expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: "" });
      expect(first.stdout).toContain("LibreDB is installed and every verify check passed.");

      // No PostgreSQL of the installation's own: the apps reach the external server with verify-full.
      const compose = parse(readFileSync(join(INSTALL_ROOT, "compose.yaml"), "utf8")) as {
        services: Record<string, unknown>;
        networks: Record<string, { internal?: boolean } | null>;
      };
      expect(Object.keys(compose.services)).not.toContain("postgres");
      const containers = parseComposePs(sh(["docker", "compose", "-p", PROJECT, "ps", "--all", "--format", "json"]).stdout);
      expect(containers.map((container) => container.service)).not.toContain("postgres");
      const platformEnv = readFileSync(join(INSTALL_ROOT, "env", "platform.env"), "utf8");
      expect(platformEnv).toContain(
        `@${SERVER_HOST}:5432/libredb?schema=platform&sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt`,
      );
      const keycloak = compose.services.keycloak as { environment: Record<string, string> };
      expect(keycloak.environment.KC_DB_URL).toBe(
        `jdbc:postgresql://${SERVER_HOST}:5432/keycloak?sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt`,
      );
      expect(psqlAsSuperuser("SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE datname IN ('libredb', 'keycloak')")).toBe(
        "keycloak,libredb",
      );
      expect(psqlAsSuperuser("SELECT count(*) FROM bridge.contract", "libredb")).not.toBe("0");

      // The renewal timer's run: no admin password and no terminal, with unchanged inputs.
      const second = await installer(["apply", ...configArgs(), "--yes"], false);
      expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: "" });
      expect(second.stdout).toContain("No changes");
      expect(second.stdout).toContain(
        "postgres-provision was skipped, because its inputs are unchanged since it last succeeded and no password of " +
          `the admin role ${ADMIN_USER} of the external PostgreSQL server ${SERVER_HOST}:5432 is supplied`,
      );
      expect(second.stdout).toContain("LibreDB is installed and every verify check passed.");

      const verify = await installer(["verify", ...configArgs(), "--output", "json"], false);
      const report = JSON.parse(verify.stdout) as Report;
      expect(report.checks.map((check) => check.id)).toEqual(CATALOGUE.map((check) => check.id));
      expect(report.checks.filter((check) => check.result === "failed")).toEqual([]);
      expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });
    },
    LONG,
  );

  test(
    "the admin password appears in no file under /opt/libredb and in no command output",
    () => {
      const files = filesUnder(INSTALL_ROOT);
      expect(files.length).toBeGreaterThan(10);
      for (const path of files) {
        expect({ path, found: readFileSync(path).includes(adminPassword) }).toEqual({ path, found: false });
      }
      expect(printed.join("\n").includes(adminPassword)).toBe(false);
      // The server received the role passwords as SCRAM verifiers only. Keycloak keeps its client secrets in its own
      // database, so the statement log holds those, as it would on any server.
      const logs = sh(["docker", "logs", EXTERNAL]);
      const text = `${logs.stdout}${logs.stderr}`;
      expect(text.includes("PASSWORD 'SCRAM-SHA-256$4096:")).toBe(true);
      const store = JSON.parse(readFileSync(join(INSTALL_ROOT, "secrets", "secrets.json"), "utf8")) as {
        values: Record<string, string>;
      };
      expect(Object.keys(store.values)).not.toContain("postgres-superuser-password");
      const rolePasswords = Object.entries(store.values).filter(([name]) => /^postgres-[a-z]+-password$/.test(name));
      expect(rolePasswords.map(([name]) => name).sort()).toEqual([
        "postgres-backup-password",
        "postgres-keycloak-password",
        "postgres-owner-password",
        "postgres-platform-password",
        "postgres-studio-password",
      ]);
      for (const [name, value] of rolePasswords) {
        expect({ name, found: text.includes(value) }).toEqual({ name, found: false });
      }
    },
    LONG,
  );
});
