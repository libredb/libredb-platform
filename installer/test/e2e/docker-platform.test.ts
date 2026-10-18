// Platform in Docker mode end to end: the compiled installer migrates and deploys Platform after the skeleton, as root
// under /opt/libredb in the Compose project libredb, and verify proves it ready and wired to Keycloak and the bridge.
// It needs a disposable Linux host with Docker, because it removes any earlier install first.
// LIBREDB_INSTALLER_BIN names another installer binary than dist/libredb-installer-linux-x64, and
// LIBREDB_E2E_IMAGES_REGISTRY sets images.registry for every run, such as registry.example.com/libredb for images
// that exist only in a registry mirror. Every install names the license file of LIBREDB_E2E_LICENSE_FILE, which
// ./support/install.ts requires, and the license tests also apply tokens that no key signed.
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { parseComposePs, type ComposeContainer } from "../../src/adapters/docker";
import { migrateJobCommand } from "../../src/platform/migrate-outcome";
import { parseComposeEnvFile } from "../../src/render/compose";
import { LICENSE, LICENSE_ARGS, LICENSE_FILE } from "./support/install";

const packageRoot = join(import.meta.dir, "..", "..");
const INSTALLER = process.env.LIBREDB_INSTALLER_BIN ?? join(packageRoot, "dist", "libredb-installer-linux-x64");
const CONFIG = join(packageRoot, "test", "fixtures", "configs", "docker.yaml");
const REGISTRY = process.env.LIBREDB_E2E_IMAGES_REGISTRY;
const REGISTRY_ARGS = REGISTRY === undefined || REGISTRY === "" ? [] : ["--set", `images.registry=${REGISTRY}`];
const CONFIG_ARGS = ["-c", CONFIG, ...REGISTRY_ARGS, ...LICENSE_ARGS];
const INSTALL_ROOT = "/opt/libredb";
const PROJECT = "libredb";
const LONG = 15 * 60_000;

const PLATFORM_CHECKS = [
  "platform-ready",
  "platform-signin-redirect",
  "platform-admin-api",
  "bridge-contract",
  "seal-canary-published",
  "bridge-privileges",
];

// A migration the history records as started and never finished, as an interrupted upgrade leaves it.
const FAILED_MIGRATION = "20261015235959_e2e_interrupted";

// The token of the license file of every install, read to compare and to search for, never printed: a failed
// assertion shows only whether each value matched, and `hidden` replaces it in a text that an assertion shows.
const LICENSE_TOKEN = readFileSync(LICENSE_FILE, "utf8").replace(/\r?\n$/, "");
const hidden = (text: string) => text.replaceAll(LICENSE_TOKEN, "<the license token>");
/** Where the license tests write the license files and the configuration they apply; removed at their end. */
const LICENSE_DIR = "/root/libredb-e2e-license";
/** The start of the issue that validate and apply print for a configuration without platform.licenseFile. */
const LICENSE_REQUIRED = "platform.licenseFile: every install needs a license file from LibreDB, the free license included";
const DAY_MS = 86_400_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
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

function containers(): ComposeContainer[] {
  return parseComposePs(sh(["docker", "compose", "-p", PROJECT, "ps", "--all", "--format", "json"]).stdout);
}

function platformContainer(): ComposeContainer {
  const found = containers().find((container) => container.service === "platform");
  if (found === undefined) throw new Error("the project has no platform container");
  return found;
}

/** Runs SQL in database libredb as the superuser, over the server's local socket inside its own container. */
function psqlAsSuperuser(sql: string): string {
  const script = 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d libredb -c "$1"';
  return sh(["docker", "exec", `${PROJECT}-postgres-1`, "sh", "-c", script, "sh", sql]).stdout;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

/** An env file of the installation, read as the installer wrote it. */
function envFile(name: string): Map<string, string> {
  return parseComposeEnvFile(readFileSync(join(INSTALL_ROOT, "env", name), "utf8"));
}

/** The output of a container, as `docker logs` prints its standard output and standard error. */
function containerLog(id: string): string {
  const logs = sh(["docker", "logs", id]);
  return `${logs.stdout}\n${logs.stderr}`;
}

/**
 * The lines in which Platform's container logged its license status, which it does once at start: Platform logs JSON
 * in production, and each such line holds the state and either the failure code or the license's id and expiry.
 */
function licenseLines(id: string): Record<string, unknown>[] {
  return containerLog(id)
    .split("\n")
    .flatMap((line) => {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return [];
      }
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      return typeof record.state === "string" && /licen[cs]e/i.test(String(record.message)) ? [record] : [];
    });
}

/**
 * A value of the license token's shape that no key signed, under a kid that no build holds, so Platform reads it as
 * invalid with LICENSE_UNKNOWN_KID. The installer checks only the shape.
 */
function unsignedLicense(id: string): string {
  const payload = { v: 1, id, customer: "LibreDB E2E", adminSeats: 2, userSeats: 10, issuedAt: 1_792_108_800, expiresAt: 1_823_644_800 };
  return ["ldl1", "0123456789abcdef", Buffer.from(JSON.stringify(payload)).toString("base64url"), Buffer.alloc(64).toString("base64url")].join(".");
}

/** The state that docs/deploy/platform-runtime.md gives a verified license that expires at `expiresAt` (epoch seconds). */
function verifiedLicenseState(expiresAt: number, nowMs: number): string {
  if (nowMs < expiresAt * 1000 - 30 * DAY_MS) return "active";
  if (nowMs < expiresAt * 1000) return "expiring";
  if (nowMs < expiresAt * 1000 + 14 * DAY_MS) return "grace";
  return "expired";
}

/** Asserts that no text of `haystacks` holds a token, naming only the token's index and the text, never the token. */
function expectNowhere(tokens: readonly string[], haystacks: readonly { where: string; text: string }[]): void {
  for (const [index, token] of tokens.entries()) {
    for (const haystack of haystacks) {
      expect({ token: index, where: haystack.where, found: haystack.text.includes(token) }).toEqual({
        token: index,
        where: haystack.where,
        found: false,
      });
    }
  }
}

/** compose.yaml, the applied configuration, the state and the run logs of the installation. */
function installationTexts(): { where: string; text: string }[] {
  return [
    join(INSTALL_ROOT, "compose.yaml"),
    join(INSTALL_ROOT, "libredb.yaml"),
    ...filesUnder(join(INSTALL_ROOT, "state")),
    ...filesUnder(join(INSTALL_ROOT, "logs")),
  ].map((path) => ({ where: path, text: readFileSync(path, "utf8") }));
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

describe("Platform in Docker mode", () => {
  test(
    "apply brings Platform to ready with the license of LIBREDB_E2E_LICENSE_FILE, which Platform alone receives and verifies, and every Platform verify check passes",
    async () => {
      const first = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect({ code: first.code, stderr: hidden(first.stderr) }).toEqual({ code: 0, stderr: "" });
      expect(first.stdout).toContain("platform-migrate: run the Platform migrate job");
      const platform = platformContainer();
      expect({ state: platform.state, health: platform.health }).toEqual({ state: "running", health: "healthy" });
      // The migrate job ran with --rm and left no container behind.
      expect(containers().map((container) => container.service)).not.toContain("platform-migrate");

      const verify = await installer("verify", ...CONFIG_ARGS, "--output", "json");
      const report = JSON.parse(verify.stdout) as { checks: { id: string; result: string; cause: string | null; detail?: string }[] };
      for (const id of PLATFORM_CHECKS) {
        expect(report.checks.find((check) => check.id === id)).toEqual({ id, result: "passed", cause: null });
      }
      // platform-license names the license whose line Platform logged at its start.
      expect(report.checks.find((check) => check.id === "platform-license")?.detail ?? "").toStartWith(
        `${LICENSE.id} for ${LICENSE.customer}, `,
      );
      expect({ code: verify.code, stderr: hidden(verify.stderr) }).toEqual({ code: 0, stderr: "" });

      // Platform's runtime env file holds the token, which the migrate job never receives.
      expect({
        runtime: envFile("platform.env").get("PLATFORM_LICENSE") === LICENSE_TOKEN,
        migrate: envFile("platform-migrate.env").has("PLATFORM_LICENSE"),
      }).toEqual({ runtime: true, migrate: false });
      // Platform logged one license line at its start, in the state that the license's dates give at that time.
      const lines = licenseLines(platform.id);
      const [line] = lines;
      const startedAt = Date.parse(String(line?.timestamp));
      expect({
        lines: lines.length,
        state: line?.state,
        code: line?.code,
        licenseId: line?.licenseId === LICENSE.id,
        expiresAt: line?.expiresAt === new Date(LICENSE.expiresAt * 1000).toISOString(),
      }).toEqual({
        lines: 1,
        state: verifiedLicenseState(LICENSE.expiresAt, startedAt),
        code: undefined,
        licenseId: true,
        expiresAt: true,
      });
      console.log(`the license of LIBREDB_E2E_LICENSE_FILE started Platform in state ${String(line?.state)}`);

      // Platform's runtime container never receives the owner URL; only the names are compared, so a
      // failure prints no secret.
      const env = JSON.parse(sh(["docker", "inspect", `${PROJECT}-platform-1`, "--format", "{{json .Config.Env}}"]).stdout) as string[];
      const names = env.map((entry) => entry.slice(0, entry.indexOf("=")));
      expect(names).not.toContain("MIGRATE_DATABASE_URL");
      expect(names).toContain("BRIDGE_SEAL_PUBLIC_KEY");
      expect(env).toContain("DEPLOYMENT_MODE=self-hosted");
      expect(env).toContain("KEYCLOAK_ADMIN_URL=http://keycloak:8080");
      expect(env).toContain("QUERY_LOG_RETENTION_DAYS=90");

      // The state revision records the latest migration the job applied, for the rollback guard.
      const latest = psqlAsSuperuser(
        "SELECT max(migration_name) FROM platform._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
      ).trim();
      const state = JSON.parse(readFileSync(join(INSTALL_ROOT, "state", "state.json"), "utf8")) as {
        revisions: { platformMigration?: string }[];
      };
      expect(state.revisions.at(-1)?.platformMigration).toBe(latest);

      const second = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("No changes");
      expect(platformContainer().id).toBe(platform.id);
    },
    LONG,
  );

  test(
    "db-shell --as platform -c 'SELECT current_user' prints libredb_platform",
    async () => {
      const shell = await installer("db-shell", "--as", "platform", "-c", "SELECT current_user");
      expect({ code: shell.code, stdout: shell.stdout, stderr: shell.stderr }).toEqual({
        code: 0,
        stdout: "libredb_platform\n",
        stderr: "",
      });
    },
    LONG,
  );

  test(
    "a migrate that fails leaves the previous Platform container running with the same id",
    async () => {
      const before = platformContainer();
      psqlAsSuperuser(
        "INSERT INTO platform._prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) " +
          `VALUES ('e2e-interrupted', 'e2e', '${FAILED_MIGRATION}', now(), 0)`,
      );

      const failed = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("the Platform migrate job exited with code 1");
      expect(failed.stderr).toContain("P3009");
      expect(failed.stderr).toContain(migrateJobCommand("migrate-status"));
      expect(failed.stderr).toContain(migrateJobCommand("migrate-resolve", "--rolled-back", FAILED_MIGRATION));
      const after = platformContainer();
      expect({ id: after.id, state: after.state, health: after.health }).toEqual({
        id: before.id,
        state: "running",
        health: "healthy",
      });

      // The printed status command reports the failed migration.
      const status = sh(["sh", "-c", migrateJobCommand("migrate-status")], false);
      expect(`${status.stdout}${status.stderr}`).toContain(FAILED_MIGRATION);

      // Once the history is repaired, the next apply runs the job again and leaves Platform as it was.
      psqlAsSuperuser(`DELETE FROM platform._prisma_migrations WHERE migration_name = '${FAILED_MIGRATION}'`);
      const repaired = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect({ code: repaired.code, stderr: repaired.stderr }).toEqual({ code: 0, stderr: "" });
      expect(repaired.stdout).toContain("platform-migrate: run the Platform migrate job");
      expect(platformContainer().id).toBe(before.id);
      expect((await installer("plan", ...CONFIG_ARGS)).stdout).toContain("No changes");
    },
    LONG,
  );

  test(
    "no generated secret, seal private key or license token appears in compose.yaml, the state, the logs or the command output",
    () => {
      const store = JSON.parse(readFileSync(join(INSTALL_ROOT, "secrets", "secrets.json"), "utf8")) as {
        values: Record<string, string>;
        sealKeys: { privateKey: string }[];
      };
      const secrets = [...Object.values(store.values), ...store.sealKeys.map((key) => key.privateKey), LICENSE_TOKEN];
      expect(Object.keys(store.values)).toEqual(
        expect.arrayContaining(["platform-auth-secret", "studio-jwt-secret", "studio-storage-encryption-key"]),
      );
      expect(store.sealKeys).toHaveLength(1);
      const haystacks = [
        { where: "compose.yaml", text: readFileSync(join(INSTALL_ROOT, "compose.yaml"), "utf8") },
        ...[...filesUnder(join(INSTALL_ROOT, "state")), ...filesUnder(join(INSTALL_ROOT, "logs"))].map((path) => ({
          where: path,
          text: readFileSync(path, "utf8"),
        })),
        { where: "the command output", text: printed.join("\n") },
      ];
      for (const [index, secret] of secrets.entries()) {
        for (const haystack of haystacks) {
          expect({ secret: index, where: haystack.where, found: haystack.text.includes(secret) }).toEqual({
            secret: index,
            where: haystack.where,
            found: false,
          });
        }
      }
      // Each env file is root-only, and Platform's two never share a file.
      for (const name of ["platform.env", "platform-migrate.env"]) {
        const path = join(INSTALL_ROOT, "env", name);
        expect({ name, mode: (statSync(path).mode & 0o777).toString(8), uid: statSync(path).uid }).toEqual({
          name,
          mode: "600",
          uid: 0,
        });
      }
    },
    LONG,
  );

  test(
    "a token no key signed recreates Platform and makes apply exit 4 naming its code, a missing file, a link or a directory exits 2, validate and apply exit 2 without platform.licenseFile before they change anything, the license of LIBREDB_E2E_LICENSE_FILE recreates Platform again, and no output carries a token",
    async () => {
      rmSync(LICENSE_DIR, { recursive: true, force: true });
      mkdirSync(LICENSE_DIR, { recursive: true, mode: 0o700 });
      const licenseFile = join(LICENSE_DIR, "libredb.license");
      const tokens = [unsignedLicense("E2E-UNSIGNED-1"), unsignedLicense("E2E-UNSIGNED-2")];
      const texts: { where: string; text: string }[] = [];
      const run = async (where: string, ...args: string[]) => {
        const result = await installer(...args);
        texts.push({ where: `${where} stdout`, text: result.stdout }, { where: `${where} stderr`, text: result.stderr });
        return result;
      };
      const apply = (file: string) => run(`apply with ${file}`, "apply", ...CONFIG_ARGS, "--set", `platform.licenseFile=${file}`, "--yes");
      try {
        // Every earlier test applied with the license of LIBREDB_E2E_LICENSE_FILE.
        let previous = platformContainer().id;
        expect(envFile("platform.env").get("PLATFORM_LICENSE") === LICENSE_TOKEN).toBe(true);
        expect(licenseLines(previous).map(({ licenseId }) => licenseId === LICENSE.id)).toEqual([true]);

        // Each new token is a changed env file, which recreates Platform; the migrate job never receives it.
        // Platform refuses a token no key signed, so the check platform-license alone fails and apply exits 4.
        for (const token of tokens) {
          writeFileSync(licenseFile, `${token}\n`, { mode: 0o600 });
          const refused = await apply(licenseFile);
          expect({ code: refused.code, stderr: hidden(refused.stderr) }).toEqual({ code: 4, stderr: "" });
          expect(refused.stdout).toContain("LibreDB is installed, but 1 of ");
          expect(refused.stdout).toContain(
            `  platform-license: the license token in ${licenseFile} fails Platform's verification with LICENSE_UNKNOWN_KID, ` +
              "because a key that this Platform build does not hold signed it, so Platform adds no user, connection or admin " +
              "until a valid license is installed\n",
          );
          expect(refused.stdout).toContain("License: invalid, LICENSE_UNKNOWN_KID, no seat can be added\n");
          const platform = platformContainer();
          expect({ recreated: platform.id !== previous, state: platform.state, health: platform.health }).toEqual({
            recreated: true,
            state: "running",
            health: "healthy",
          });
          expect({
            runtime: envFile("platform.env").get("PLATFORM_LICENSE") === token,
            migrate: envFile("platform-migrate.env").has("PLATFORM_LICENSE"),
          }).toEqual({ runtime: true, migrate: false });
          expect(licenseLines(platform.id).map(({ state, code }) => ({ state, code }))).toEqual([
            { state: "invalid", code: "LICENSE_UNKNOWN_KID" },
          ]);
          texts.push({ where: `the log of Platform container ${platform.id}`, text: containerLog(platform.id) });
          previous = platform.id;
        }
        // The applied configuration keeps the absolute path, which the renewal timer's apply reads.
        const applied = parse(readFileSync(join(INSTALL_ROOT, "libredb.yaml"), "utf8")) as {
          platform?: { licenseFile?: unknown };
        };
        expect(applied.platform?.licenseFile).toBe(licenseFile);

        // A missing file, a symbolic link and a directory each stop apply with exit 2 while it plans, naming the path.
        const missing = join(LICENSE_DIR, "missing.license");
        const absent = await apply(missing);
        expect({
          code: absent.code,
          named: absent.stderr.includes(`platform.licenseFile: the file ${missing} that platform.licenseFile names does not exist`),
        }).toEqual({ code: 2, named: true });
        const link = join(LICENSE_DIR, "link.license");
        symlinkSync(licenseFile, link);
        const directory = join(LICENSE_DIR, "directory.license");
        mkdirSync(directory);
        for (const path of [link, directory]) {
          const refused = await apply(path);
          expect({ path, code: refused.code, named: refused.stderr.includes(`${path} exists but is not a regular file`) }).toEqual({
            path,
            code: 2,
            named: true,
          });
        }
        expect(platformContainer().id).toBe(previous);

        // Without platform.licenseFile, validate and apply exit 2 naming the license that every install needs, before
        // apply opens its run log or reads the host: the container, its env file and the state stay as they were.
        const document = parse(readFileSync(CONFIG, "utf8")) as { platform: Record<string, unknown> };
        delete document.platform.licenseFile;
        const unlicensed = join(LICENSE_DIR, "unlicensed.yaml");
        writeFileSync(unlicensed, stringify(document), { mode: 0o600 });
        // The files by their digests, so a failed assertion prints none of the secrets of the env file.
        const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
        const installed = () => ({
          platform: platformContainer().id,
          env: digest(join(INSTALL_ROOT, "env", "platform.env")),
          state: digest(join(INSTALL_ROOT, "state", "state.json")),
          logs: filesUnder(join(INSTALL_ROOT, "logs")),
        });
        const before = installed();
        for (const command of [["validate"], ["apply", "--yes"]]) {
          const [name = ""] = command;
          const refused = await run(`${name} without platform.licenseFile`, name, "-c", unlicensed, ...REGISTRY_ARGS, ...command.slice(1));
          expect({ name, code: refused.code, stdout: refused.stdout, refused: refused.stderr.includes(LICENSE_REQUIRED) }).toEqual({
            name,
            code: 2,
            stdout: "",
            refused: true,
          });
        }
        expect(installed()).toEqual(before);

        // The license of LIBREDB_E2E_LICENSE_FILE changes the env file again, so Platform is recreated and starts
        // with it.
        const relicensed = await run("apply with the license of LIBREDB_E2E_LICENSE_FILE", "apply", ...CONFIG_ARGS, "--yes");
        expect({ code: relicensed.code, stderr: hidden(relicensed.stderr) }).toEqual({ code: 0, stderr: "" });
        const platform = platformContainer();
        expect({ recreated: platform.id !== previous, health: platform.health }).toEqual({ recreated: true, health: "healthy" });
        expect(envFile("platform.env").get("PLATFORM_LICENSE") === LICENSE_TOKEN).toBe(true);
        expect(licenseLines(platform.id).map(({ licenseId }) => licenseId === LICENSE.id)).toEqual([true]);
        texts.push({ where: `the log of Platform container ${platform.id}`, text: containerLog(platform.id) });

        expectNowhere([...tokens, LICENSE_TOKEN], [...texts, ...installationTexts()]);
      } finally {
        rmSync(LICENSE_DIR, { recursive: true, force: true });
      }
    },
    LONG,
  );
});
