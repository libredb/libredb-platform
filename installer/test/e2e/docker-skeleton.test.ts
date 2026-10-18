// The Docker walking skeleton end to end: the compiled installer applies the edge, the managed PostgreSQL and the
// managed Keycloak with the LibreDB objects on this host as root, under /opt/libredb and as the Compose project
// libredb, exactly as an operator runs it.
// It needs a disposable Linux host with Docker, because it removes any earlier skeleton install first.
// LIBREDB_INSTALLER_BIN names another installer binary than dist/libredb-installer-linux-x64, and
// LIBREDB_E2E_IMAGES_REGISTRY sets images.registry for every run, such as registry.example.com/libredb for images
// that exist only in a registry mirror.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseComposePs, type ComposeContainer } from "../../src/adapters/docker";
import { KeycloakAdmin } from "../../src/adapters/keycloak-admin";
import { INSTALLER_CLIENT_ID, parseEnvFile } from "../../src/steps/keycloak-handover";
import { LICENSE_ARGS } from "./support/install";

const packageRoot = join(import.meta.dir, "..", "..");
const INSTALLER = process.env.LIBREDB_INSTALLER_BIN ?? join(packageRoot, "dist", "libredb-installer-linux-x64");
const CONFIG = join(packageRoot, "test", "fixtures", "configs", "docker.yaml");
const REGISTRY = process.env.LIBREDB_E2E_IMAGES_REGISTRY;
const CONFIG_ARGS = [
  "-c",
  CONFIG,
  ...(REGISTRY === undefined || REGISTRY === "" ? [] : ["--set", `images.registry=${REGISTRY}`]),
  ...LICENSE_ARGS,
];
const INSTALL_ROOT = "/opt/libredb";
const PROJECT = "libredb";
const LONG = 15 * 60_000;
// The one file of the secrets directory that a container mounts, readable only by the uid Studio runs as.
const STUDIO_KEYRING = join(INSTALL_ROOT, "secrets", "studio-keyring.json");

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

function containerIds(): Record<string, string> {
  return Object.fromEntries(containers().map((container) => [container.service, container.id]));
}

interface InspectedContainer {
  Name: string;
  Config: { Hostname: string; Env: string[] | null; Labels: Record<string, string> | null };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
}

/** `docker inspect` of every container on this host. */
function inspectContainers(): InspectedContainer[] {
  const ids = sh(["docker", "ps", "--all", "--quiet"]).stdout.split("\n").filter(Boolean);
  return ids.length === 0 ? [] : (JSON.parse(sh(["docker", "inspect", ...ids]).stdout) as InspectedContainer[]);
}

function serviceOf(container: InspectedContainer): string {
  return container.Config.Labels?.["com.docker.compose.service"] ?? container.Name;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
}

/** What an apply could change on this host: the files under /opt/libredb and the project's Docker objects. */
function hostSnapshot(): string {
  const files = filesUnder(INSTALL_ROOT).map((path) => {
    const stats = statSync(path);
    return `${path} ${stats.size} ${stats.mtimeMs} ${(stats.mode & 0o777).toString(8)}`;
  });
  const label = `label=com.docker.compose.project=${PROJECT}`;
  const objects = [
    sh(["docker", "ps", "--all", "--filter", label, "--format", "{{.ID}} {{.Names}} {{.State}}"]).stdout,
    sh(["docker", "network", "ls", "--filter", label, "--format", "{{.ID}} {{.Name}}"]).stdout,
    sh(["docker", "volume", "ls", "--filter", label, "--format", "{{.Name}}"]).stdout,
  ];
  return [...files, ...objects].join("\n");
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

function newestLog(): string {
  const logs = filesUnder(join(INSTALL_ROOT, "logs")).filter((path) => /installer-[^/]+\.log$/.test(path));
  const newest = logs.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
  if (newest === undefined) throw new Error(`no installer log under ${INSTALL_ROOT}/logs`);
  return readFileSync(newest, "utf8");
}

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

beforeAll(() => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("the Docker end-to-end tests need root on a disposable Linux host with Docker");
  }
  if (!existsSync(INSTALLER)) throw new Error(`${INSTALLER} does not exist; run bun run build first`);
  removeEarlierInstall();
});

describe("Docker walking skeleton", () => {
  test(
    "apply without a TTY and without --yes exits 2 and changes nothing",
    async () => {
      const before = hostSnapshot();
      const result = await installer("apply", ...CONFIG_ARGS);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--yes");
      expect(hostSnapshot()).toBe(before);
    },
    LONG,
  );

  test(
    "apply brings edge, postgres, keycloak, platform and studio to healthy and a second apply prints No changes",
    async () => {
      const first = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect(first.stderr).toBe("");
      expect(first.code).toBe(0);
      const running = containers();
      expect(running.map((container) => container.service).sort()).toEqual([
        "edge",
        "keycloak",
        "platform",
        "postgres",
        "studio",
      ]);
      for (const container of running) {
        expect({ service: container.service, state: container.state, health: container.health }).toEqual({
          service: container.service,
          state: "running",
          health: "healthy",
        });
      }
      const ids = containerIds();

      const second = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("No changes");
      expect(containerIds()).toEqual(ids);
      // The second run authenticates as libredb-installer and only reads the Admin API.
      const adminRequests = [...newestLog().matchAll(/keycloak ([A-Z]+) (\/admin\/\S*)/g)].map((match) => match[1]);
      expect(adminRequests.length).toBeGreaterThan(0);
      expect(new Set(adminRequests)).toEqual(new Set(["GET"]));
      expect(newestLog()).not.toContain("as libredb-bootstrap");

      expect(mode(join(INSTALL_ROOT, "state", "state.json"))).toBe("600");
      const secretFiles = filesUnder(join(INSTALL_ROOT, "secrets"));
      expect(secretFiles).toContain(STUDIO_KEYRING);
      // Every secret file is root's alone, except the keyring, which the uid Studio runs as reads.
      for (const file of secretFiles) {
        expect({ file, mode: mode(file) }).toEqual({ file, mode: file === STUDIO_KEYRING ? "400" : "600" });
      }

      const status = await installer("status");
      expect(status.code).toBe(0);
      expect(status.stdout).toMatch(/edge-deploy\s+applied/);
      expect(status.stdout).toMatch(/postgres\s+running\s+healthy/);
    },
    LONG,
  );

  test(
    "apply --only edge-deploy on a converged install runs only that step and changes nothing",
    async () => {
      const ids = containerIds();
      const before = filesUnder(INSTALL_ROOT)
        .filter((path) => !path.startsWith(join(INSTALL_ROOT, "logs")))
        .map((path) => `${path} ${statSync(path).mtimeMs}`);

      const result = await installer("apply", ...CONFIG_ARGS, "--yes", "--only", "edge-deploy");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("No changes");
      expect(containerIds()).toEqual(ids);
      const after = filesUnder(INSTALL_ROOT)
        .filter((path) => !path.startsWith(join(INSTALL_ROOT, "logs")))
        .map((path) => `${path} ${statSync(path).mtimeMs}`);
      expect(after).toEqual(before);

      const planned = [...newestLog().matchAll(/step ([a-z-]+): /g)].map((match) => match[1]);
      expect(new Set(planned)).toEqual(new Set(["edge-deploy"]));
    },
    LONG,
  );

  test(
    "verify --output json reports postgres-privileges as passed",
    async () => {
      const result = await installer("verify", ...CONFIG_ARGS, "--output", "json");
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as { checks: { id: string; result: string; cause: string | null }[] };
      expect(report.checks.find((check) => check.id === "postgres-privileges")).toEqual({
        id: "postgres-privileges",
        result: "passed",
        cause: null,
      });

      const status = await installer("status");
      expect(status.stdout).toMatch(/postgres-provision\s+(applied|unchanged)/);
    },
    LONG,
  );

  test(
    "a second apply plans zero Keycloak actions, and plan after editing the libredb-studio redirect URI in the console prints exactly one update client libredb-studio action",
    async () => {
      const converged = await installer("plan", ...CONFIG_ARGS);
      expect(converged.code).toBe(0);
      expect(converged.stdout).toContain("No changes");
      expect(newestLog()).toContain("step keycloak-configure: 0 actions planned");

      // The operator's edit, made through the Admin API on the loopback port as the console makes it.
      const secret = parseEnvFile(readFileSync(join(INSTALL_ROOT, "secrets", "installer.env"), "utf8")).get(
        "KEYCLOAK_INSTALLER_CLIENT_SECRET",
      );
      if (secret === undefined) throw new Error("installer.env holds no secret");
      const admin = new KeycloakAdmin({
        baseUrl: "http://127.0.0.1:18080",
        credentials: { realm: "libredb", clientId: INSTALLER_CLIENT_ID, clientSecret: secret },
        log: () => {},
      });
      const [studio] = await admin.get<(Record<string, unknown> & { id: string })[]>(
        "/admin/realms/libredb/clients?clientId=libredb-studio",
      );
      if (studio === undefined) throw new Error("realm libredb has no client libredb-studio");
      const { protocolMappers: _mappers, ...client } = studio;
      await admin.write("PUT", `/admin/realms/libredb/clients/${studio.id}`, {
        ...client,
        redirectUris: ["https://studio.libredb.test/edited/callback"],
      });

      const drifted = await installer("plan", ...CONFIG_ARGS);
      expect(drifted.code).toBe(0);
      expect(drifted.stdout.split("\n").filter((line) => line.includes("update client libredb-studio"))).toEqual([
        "  - update client libredb-studio (redirectUris)",
      ]);
      expect(drifted.stdout).toContain("1 change in 1 step");

      const repaired = await installer("apply", ...CONFIG_ARGS, "--yes");
      expect(repaired.code).toBe(0);
      expect(repaired.stdout).toContain("Apply complete: 1 change");
      expect((await installer("plan", ...CONFIG_ARGS)).stdout).toContain("No changes");
    },
    LONG,
  );

  test(
    "the handover leaves no bootstrap credential and a root-only installer.env that no container mounts",
    () => {
      const keycloakEnv = join(INSTALL_ROOT, "env", "keycloak.env");
      expect(sh(["grep", "-c", "KC_BOOTSTRAP", keycloakEnv], false).stdout.trim()).toBe("0");
      const installerEnv = join(INSTALL_ROOT, "secrets", "installer.env");
      expect(sh(["stat", "-c", "%a %U", installerEnv]).stdout.trim()).toBe("600 root");
      // No container reaches the secrets directory or installer.env in it; only the keyring leaves it, as a file alone.
      const secretsDir = join(INSTALL_ROOT, "secrets");
      for (const container of inspectContainers()) {
        const fromSecrets = container.Mounts.map((mount) => mount.Source).filter(
          (source) => (source === secretsDir || source.startsWith(`${secretsDir}/`)) && source !== STUDIO_KEYRING,
        );
        expect({ container: container.Name, fromSecrets }).toEqual({ container: container.Name, fromSecrets: [] });
      }
    },
    LONG,
  );

  test(
    "the Studio keyring is mode 0400 and owned by uid 1001, and only studio mounts it, read-only",
    () => {
      expect(sh(["stat", "-c", "%a %u", STUDIO_KEYRING]).stdout.trim()).toBe("400 1001");
      const keyringMounts = inspectContainers().flatMap((container) =>
        container.Mounts.filter((mount) => mount.Source === STUDIO_KEYRING).map((mount) => ({
          service: serviceOf(container),
          destination: mount.Destination,
          writable: mount.RW,
        })),
      );
      expect(keyringMounts).toEqual([
        { service: "studio", destination: "/etc/libredb/governance/keyring.json", writable: false },
      ]);
      expect(sh(["stat", "-c", "%a %u", join(INSTALL_ROOT, "env", "studio.env")]).stdout.trim()).toBe("600 0");
    },
    LONG,
  );

  test(
    "studio runs with the hostname libredb-studio and GOVERNANCE_INSTANCE_ID=libredb-studio, which a recreate keeps",
    () => {
      const [studio] = inspectContainers().filter((container) => serviceOf(container) === "studio");
      if (studio === undefined) throw new Error("the project has no studio container");
      expect(studio.Config.Hostname).toBe("libredb-studio");
      // Only this variable is compared, so a failure prints none of the secrets in Studio's environment.
      const instanceIds = (studio.Config.Env ?? []).filter((entry) => entry.startsWith("GOVERNANCE_INSTANCE_ID="));
      expect(instanceIds).toEqual(["GOVERNANCE_INSTANCE_ID=libredb-studio"]);
    },
    LONG,
  );

  test(
    "the edge answers 404 on the Keycloak admin console of https://auth.libredb.test/admin/",
    () => {
      const status = sh([
        "curl",
        "--cacert",
        join(INSTALL_ROOT, "ca", "ca.crt"),
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "https://auth.libredb.test/admin/",
      ]);
      expect(status.stdout).toBe("404");
      const discovery = sh([
        "curl",
        "--cacert",
        join(INSTALL_ROOT, "ca", "ca.crt"),
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "https://auth.libredb.test/realms/libredb/.well-known/openid-configuration",
      ]);
      expect(discovery.stdout).toBe("200");
    },
    LONG,
  );

  test(
    "no generated secret value appears in compose.yaml, the state, the logs or the command output",
    () => {
      const store = JSON.parse(readFileSync(join(INSTALL_ROOT, "secrets", "secrets.json"), "utf8")) as {
        values: Record<string, string>;
      };
      const installerSecret = /^KEYCLOAK_INSTALLER_CLIENT_SECRET=(.+)$/m.exec(
        readFileSync(join(INSTALL_ROOT, "secrets", "installer.env"), "utf8"),
      )?.[1];
      expect(installerSecret).toBeDefined();
      const temporaryPasswords = ["first-admin.txt", "user-manager.txt"].map((name) =>
        readFileSync(join(INSTALL_ROOT, "secrets", name), "utf8").trim(),
      );
      const secrets = [...Object.values(store.values), installerSecret as string, ...temporaryPasswords];
      expect(secrets.length).toBeGreaterThan(1);
      const haystacks = [
        { where: "compose.yaml", text: readFileSync(join(INSTALL_ROOT, "compose.yaml"), "utf8") },
        ...[...filesUnder(join(INSTALL_ROOT, "state")), ...filesUnder(join(INSTALL_ROOT, "logs"))].map((path) => ({
          where: path,
          text: readFileSync(path, "utf8"),
        })),
        { where: "the command output", text: printed.join("\n") },
      ];
      expect(haystacks.some((haystack) => haystack.where.includes("/logs/"))).toBe(true);
      for (const [index, secret] of secrets.entries()) {
        for (const haystack of haystacks) {
          expect({ secret: index, where: haystack.where, found: haystack.text.includes(secret) }).toEqual({
            secret: index,
            where: haystack.where,
            found: false,
          });
        }
      }
    },
    LONG,
  );

  test(
    "docker compose -p libredb logs postgres contains no generated password",
    () => {
      const store = JSON.parse(readFileSync(join(INSTALL_ROOT, "secrets", "secrets.json"), "utf8")) as {
        values: Record<string, string>;
      };
      const passwords = Object.entries(store.values).filter(([name]) => name.startsWith("postgres-"));
      // The superuser and one password per provisioned role.
      expect(passwords.length).toBeGreaterThan(1);
      const logs = sh(["docker", "compose", "-p", PROJECT, "logs", "--no-color", "postgres"]);
      const text = `${logs.stdout}${logs.stderr}`;
      expect(text).toContain("database system is ready to accept connections");
      for (const [name, password] of passwords) {
        expect({ name, found: text.includes(password) }).toEqual({ name, found: false });
      }
    },
    LONG,
  );
});
