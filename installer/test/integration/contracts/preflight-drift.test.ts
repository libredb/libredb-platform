// Runs the pinned Platform and Studio images with the environments the installer renders, so an app release that
// renames or adds a required variable fails here before a release pins it. PostgreSQL runs the pinned release image
// with TLS from a test CA and is provisioned as the postgres-provision step does, on a private internal network
// `data` where the server answers as `postgres`. Platform's migrate job runs with the rendered migrate env over
// verify-full TLS, then Platform serve and Studio start with the rendered env files, the CA bundle and the Studio
// keyring mounted read-only. A container counts as booted when it still runs after 30 s and its liveness route
// answers 200 inside the container. Nothing publishes a host port.
// LIBREDB_IT_PREFIX names the containers, the network, the volumes and the scratch directory (default
// libredb-it-drift), and LIBREDB_IT_APP_REGISTRY a registry mirror for the Platform and Studio images, such as
// registry.example.com/libredb (default: the pinned upstream repositories).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readReferencedFile } from "../../../src/adapters/host-fs";
import { DockerPsqlRunner } from "../../../src/adapters/psql-docker";
import { embeddedRelease } from "../../../src/cli/release";
import { loadConfig } from "../../../src/config/load";
import { Redactor } from "../../../src/log/redact";
import { CA_BUNDLE_PATH, type PostgresServer } from "../../../src/model/database-urls";
import { computeDesired } from "../../../src/model/desired";
import { readPlatformLicense, renderPlatformEnv, renderPlatformMigrateEnv } from "../../../src/model/platform-env";
import { renderStudioEnv } from "../../../src/model/studio-env";
import { imageReference } from "../../../src/release/images";
import { renderPgHba } from "../../../src/render/compose";
import { generateSecret } from "../../../src/secrets/generate";
import { renderKeyring } from "../../../src/secrets/keyring";
import { generateSealKeyPair } from "../../../src/secrets/seal-keys";
import { APP_ROLES, type AppRole } from "../../../src/sql/provision";
import { emptyState } from "../../../src/state/store";
import { applyProvision, observeProvision, planProvisionRun } from "../../../src/steps/postgres-provision";
import { createCa } from "../../../src/tls/ca";
import { issueLeaf } from "../../../src/tls/leaf";

const PREFIX = process.env.LIBREDB_IT_PREFIX ?? "libredb-it-drift";
const APP_REGISTRY = process.env.LIBREDB_IT_APP_REGISTRY || undefined;
const NETWORK = `${PREFIX}-data`;
const POSTGRES = `${PREFIX}-postgres`;
const LONG = 10 * 60_000;
const BOOT_MS = 30_000;
// Studio runs as uid 1001, the only user that may read the keyring.
const STUDIO_UID = 1001;

const release = embeddedRelease();
const PLATFORM_IMAGE = imageReference(release.images.platform, APP_REGISTRY);
const STUDIO_IMAGE = imageReference(release.images.studio, APP_REGISTRY);
const POSTGRES_IMAGE = imageReference(release.images.postgres, undefined);

const packageRoot = join(import.meta.dir, "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), `${PREFIX}-`));
const redactor = new Redactor();

// Platform's env always holds PLATFORM_LICENSE, here from a license file with a value of the token's shape that no key
// signed: Platform starts with it in state invalid, which is all a boot check needs.
const LICENSE_FILE = join(scratch, "libredb.license");
const placeholder = ["ldl1", "0123456789abcdef", Buffer.from('{"v":1}').toString("base64url"), Buffer.alloc(64).toString("base64url")];
writeFileSync(LICENSE_FILE, `${placeholder.join(".")}\n`, { mode: 0o600 });
const config = loadConfig({
  file: join(packageRoot, "test", "fixtures", "configs", "docker.yaml"),
  sets: [`platform.licenseFile=${LICENSE_FILE}`],
});
const desired = computeDesired(config, release);
const server: PostgresServer = { host: "postgres", port: 5432 };
const superuserPassword = generateSecret();
const passwords = Object.fromEntries(APP_ROLES.map((role) => [role, generateSecret()])) as Record<AppRole, string>;
for (const value of [superuserPassword, ...Object.values(passwords)]) redactor.register(value);
const sealKey = generateSealKeyPair();

type Env = Readonly<Record<string, string | undefined>>;

const studioEnv: Env = renderStudioEnv(desired, {
  postgres: server,
  secrets: {
    oidcClientSecret: generateSecret(),
    jwtSecret: generateSecret(),
    storageEncryptionKey: generateSecret(),
    databasePassword: passwords.studio,
  },
});
// The keyring volume is mounted on the directory of the file the rendered Studio env names.
const KEYRING_FILE = studioEnv.GOVERNANCE_PRIVATE_KEYS_FILE as string;
const platformEnv: Env = renderPlatformEnv(desired, {
  postgres: server,
  secrets: {
    authSecret: generateSecret(),
    license: readPlatformLicense(config.platform, readReferencedFile, redactor),
    oidcClientSecret: generateSecret(),
    databasePassword: passwords.platform,
  },
  sealPublicKey: sealKey.publicKey,
});
const migrateEnv: Env = renderPlatformMigrateEnv(desired, {
  postgres: server,
  secrets: { databasePassword: passwords.platform, ownerPassword: passwords.owner },
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function docker(args: readonly string[], check = true): Run {
  const result = Bun.spawnSync(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`docker ${args.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

function removeEverything(): void {
  const containers = docker(["ps", "--all", "--quiet", "--filter", `name=^${PREFIX}-`]).stdout.split("\n").filter(Boolean);
  if (containers.length > 0) docker(["rm", "--force", "--volumes", ...containers], false);
  const volumes = docker(["volume", "ls", "--quiet", "--filter", `name=^${PREFIX}-`]).stdout.split("\n").filter(Boolean);
  if (volumes.length > 0) docker(["volume", "rm", "--force", ...volumes], false);
  docker(["network", "rm", NETWORK], false);
}

/** Writes an env file of the given variables, leaving out every variable whose value is undefined. */
function writeEnvFile(name: string, env: Env): string {
  const path = join(scratch, "env", `${name}.env`);
  const lines = Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}\n`]));
  writeFileSync(path, lines.join(""), { mode: 0o600 });
  return path;
}

/** A volume holding keyring.json with mode 0400 and owner uid 1001, as the installer delivers it. */
function keyringVolume(name: string, keyring: string): string {
  const volume = `${PREFIX}-${name}`;
  const source = join(scratch, "keyring", name);
  mkdirSync(source, { recursive: true, mode: 0o755 });
  // A throwaway test key, readable here so the one-shot container can install it for uid 1001.
  writeFileSync(join(source, basename(KEYRING_FILE)), keyring, { mode: 0o644 });
  docker(["volume", "create", volume]);
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--volume",
    `${source}:/source:ro`,
    "--volume",
    `${volume}:/keyring`,
    "--entrypoint",
    "install",
    POSTGRES_IMAGE,
    "-m",
    "0400",
    "-o",
    String(STUDIO_UID),
    "-g",
    String(STUDIO_UID),
    `/source/${basename(KEYRING_FILE)}`,
    `/keyring/${basename(KEYRING_FILE)}`,
  ]);
  return volume;
}

// The CA bundle goes where the rendered envs name it.
const caMount = () => ["--volume", `${join(scratch, "ca")}:${dirname(CA_BUNDLE_PATH)}:ro`];

/** Starts a detached app container on the data network. */
function start(name: string, image: string, envFile: string, mounts: readonly string[], args: readonly string[]): string {
  const container = `${PREFIX}-${name}`;
  docker(["rm", "--force", container], false);
  docker(["run", "--detach", "--name", container, "--network", NETWORK, "--env-file", envFile, ...mounts, image, ...args]);
  return container;
}

function logsOf(container: string): string {
  const logs = docker(["logs", container], false);
  return `${logs.stdout}${logs.stderr}`;
}

/** Waits for the container to stop and returns its exit code and its logs, then removes it. */
async function exitOf(container: string): Promise<{ code: number; logs: string }> {
  const deadline = Date.now() + 120_000;
  while (docker(["inspect", "--format", "{{.State.Running}}", container]).stdout.trim() === "true") {
    if (Date.now() > deadline) {
      const logs = logsOf(container);
      docker(["rm", "--force", container], false);
      throw new Error(`${container} still runs after 120 s, so it did not refuse its environment:\n${logs}`);
    }
    await Bun.sleep(500);
  }
  const code = Number(docker(["inspect", "--format", "{{.State.ExitCode}}", container]).stdout.trim());
  const logs = logsOf(container);
  docker(["rm", "--force", container], false);
  return { code, logs };
}

/**
 * Whether the container still runs after 30 s and its liveness route answers 200, asked from inside the container as
 * the images' own healthchecks do. Returns the reason it did not boot, or null.
 */
async function bootFailure(container: string, livenessPath: string): Promise<string | null> {
  await Bun.sleep(BOOT_MS);
  if (docker(["inspect", "--format", "{{.State.Running}}", container]).stdout.trim() !== "true") {
    return `${container} stopped within 30 s:\n${logsOf(container)}`;
  }
  const probe = docker(
    [
      "exec",
      container,
      "node",
      "-e",
      `fetch('http://127.0.0.1:3000${livenessPath}').then((r) => { console.log(r.status); process.exit(r.status === 200 ? 0 : 1) }, (e) => { console.log(String(e)); process.exit(1) })`,
    ],
    false,
  );
  if (probe.code !== 0) return `${livenessPath} of ${container} answered ${probe.stdout.trim()}:\n${logsOf(container)}`;
  return null;
}

const without = (env: Env, key: string): Env => ({ ...env, [key]: undefined });

let keyring: string;

beforeAll(async () => {
  removeEverything();
  for (const dir of ["tls", "ca", "env", "keyring"]) mkdirSync(join(scratch, dir), { mode: 0o755 });
  chmodSync(join(scratch, "ca"), 0o755);
  chmodSync(join(scratch, "env"), 0o700);
  const now = new Date();
  const ca = await createCa({ commonName: `${PREFIX} test CA`, now });
  const leaf = await issueLeaf(ca, [server.host], now);
  writeFileSync(join(scratch, "ca", basename(CA_BUNDLE_PATH)), ca.certPem, { mode: 0o644 });
  writeFileSync(join(scratch, "tls", "server.crt"), leaf.certPem, { mode: 0o644 });
  // A throwaway test key, copied into the server container with mode 0600 at start.
  writeFileSync(join(scratch, "tls", "server.key"), leaf.keyPem, { mode: 0o644 });
  writeFileSync(join(scratch, "tls", "pg_hba.conf"), renderPgHba(), { mode: 0o644 });
  writeFileSync(
    join(scratch, "server.env"),
    `POSTGRES_PASSWORD=${superuserPassword}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256\n`,
    { mode: 0o600 },
  );
  docker(["network", "create", "--internal", NETWORK]);
  docker([
    "run",
    "--detach",
    "--name",
    POSTGRES,
    "--network",
    NETWORK,
    "--network-alias",
    server.host,
    "--env-file",
    join(scratch, "server.env"),
    "--volume",
    `${join(scratch, "tls")}:/etc/libredb-it/source:ro`,
    "--entrypoint",
    "sh",
    POSTGRES_IMAGE,
    "-c",
    [
      // The server key must belong to the postgres user with mode 0600, which a bind mount cannot give it.
      "install -d -m 0700 -o postgres -g postgres /etc/libredb-it/tls",
      "install -m 0600 -o postgres -g postgres /etc/libredb-it/source/server.key /etc/libredb-it/tls/server.key",
      "install -m 0644 -o postgres -g postgres /etc/libredb-it/source/server.crt /etc/libredb-it/tls/server.crt",
      "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/libredb-it/tls/server.crt " +
        "-c ssl_key_file=/etc/libredb-it/tls/server.key -c hba_file=/etc/libredb-it/source/pg_hba.conf " +
        "-c password_encryption=scram-sha-256",
    ].join(" && "),
  ]);
  const deadline = Date.now() + 120_000;
  // TCP on loopback opens only after the image's first initialization, like the managed server's healthcheck.
  while (docker(["exec", POSTGRES, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], false).code !== 0) {
    if (Date.now() > deadline) throw new Error(`${POSTGRES} did not become ready within 120 s`);
    await Bun.sleep(500);
  }

  // The roles, databases and schema of the PostgreSQL bootstrap, provisioned as the postgres-provision step does.
  const runner = new DockerPsqlRunner({
    image: POSTGRES_IMAGE,
    network: NETWORK,
    caBundleFile: join(scratch, "ca", basename(CA_BUNDLE_PATH)),
    envDir: join(scratch, "env"),
    redactor,
    log: () => {},
    namePrefix: `${PREFIX}-psql`,
  });
  const target = {
    runner,
    admin: { ...server, database: "postgres", user: "postgres", password: superuserPassword },
    server,
    passwords,
    managedKeycloak: true,
    redactor,
  };
  const state = emptyState();
  const actions = planProvisionRun(await observeProvision(target), target, state);
  await applyProvision(actions, target, state, () => {});

  keyring = keyringVolume("keyring", renderKeyring([{ ...sealKey, state: "live" }]));
}, LONG);

afterAll(() => {
  removeEverything();
  rmSync(scratch, { recursive: true, force: true });
});

const studioMounts = (volume: string) => [...caMount(), "--volume", `${volume}:${dirname(KEYRING_FILE)}:ro`];

/** Starts Studio with the env and expects it to exit 1 with a banner naming the variable. */
async function expectStudioRefusal(name: string, env: Env, variable: string, volume = keyring): Promise<void> {
  const container = start(name, STUDIO_IMAGE, writeEnvFile(name, env), studioMounts(volume), []);
  const { code, logs } = await exitOf(container);
  expect({ code, names: logs.includes(variable) }).toEqual({ code: 1, names: true });
}

describe("rendered environments against the pinned app images", () => {
  test(
    "Platform migrate exits 0 with the rendered Prisma-syntax MIGRATE_DATABASE_URL over verify-full TLS, Platform serve boots with the rendered env, and serve exits 1 naming DEPLOYMENT_MODE when that variable is removed",
    async () => {
      expect(migrateEnv.MIGRATE_DATABASE_URL).toContain("sslaccept=strict");
      expect(migrateEnv.DATABASE_URL).toContain("sslmode=verify-full");
      const migrate = start("migrate", PLATFORM_IMAGE, writeEnvFile("migrate", migrateEnv), caMount(), ["migrate"]);
      const migrated = await exitOf(migrate);
      expect({ code: migrated.code, logs: migrated.code === 0 ? "" : migrated.logs }).toEqual({ code: 0, logs: "" });

      const serve = start("platform", PLATFORM_IMAGE, writeEnvFile("platform", platformEnv), caMount(), ["serve"]);
      expect(await bootFailure(serve, "/api/health/live")).toBeNull();
      docker(["rm", "--force", serve]);

      const refused = start(
        "platform-no-mode",
        PLATFORM_IMAGE,
        writeEnvFile("platform-no-mode", without(platformEnv, "DEPLOYMENT_MODE")),
        caMount(),
        ["serve"],
      );
      const { code, logs } = await exitOf(refused);
      expect({ code, names: logs.includes("DEPLOYMENT_MODE") }).toEqual({ code: 1, names: true });
    },
    LONG,
  );

  test(
    "the Studio image boots with the rendered env and exits 1 naming GOVERNANCE_POSTGRES_URL when that variable is removed",
    async () => {
      const studio = start("studio", STUDIO_IMAGE, writeEnvFile("studio", studioEnv), studioMounts(keyring), []);
      expect(await bootFailure(studio, "/api/db/health")).toBeNull();
      docker(["rm", "--force", studio]);

      await expectStudioRefusal("studio-no-url", without(studioEnv, "GOVERNANCE_POSTGRES_URL"), "GOVERNANCE_POSTGRES_URL");
    },
    LONG,
  );

  test(
    "the Studio image exits 1 naming ALLOW_CUSTOM_CONNECTIONS when it is set to true",
    async () => {
      await expectStudioRefusal(
        "studio-custom",
        { ...studioEnv, ALLOW_CUSTOM_CONNECTIONS: "true" },
        "ALLOW_CUSTOM_CONNECTIONS",
      );
    },
    LONG,
  );

  test(
    "the Studio image exits 1 naming LIBREDB_MCP_ENABLED when it is set to true",
    async () => {
      await expectStudioRefusal("studio-mcp", { ...studioEnv, LIBREDB_MCP_ENABLED: "true" }, "LIBREDB_MCP_ENABLED");
    },
    LONG,
  );

  test(
    "the Studio image exits 1 naming OIDC_ROLE_PREFIX when it is set",
    async () => {
      await expectStudioRefusal("studio-role-prefix", { ...studioEnv, OIDC_ROLE_PREFIX: "libredb_" }, "OIDC_ROLE_PREFIX");
    },
    LONG,
  );

  test(
    "the Studio image exits 1 naming GOVERNANCE_PRIVATE_KEYS_FILE when the keyring holds 17 keys",
    async () => {
      // The installer's renderKeyring refuses 17 keys, so this keyring is written directly to prove Studio does too.
      const keys = Array.from({ length: 17 }, () => generateSealKeyPair().privateKey);
      const volume = keyringVolume("keyring-17", JSON.stringify({ version: 1, keys }));
      await expectStudioRefusal("studio-17-keys", studioEnv, "GOVERNANCE_PRIVATE_KEYS_FILE", volume);
    },
    LONG,
  );
});
