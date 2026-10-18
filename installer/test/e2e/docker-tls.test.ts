// Certificates in Docker mode end to end: the compiled installer applies the whole installation as root
// under /opt/libredb, then a customer CA joins the bundle and `apply --renew-certificates` re-issues every leaf. The
// trust labels recreate exactly the services that read the bundle or the edge certificates at start, PostgreSQL loads
// its renewed leaf with pg_reload_conf() and keeps running, and verify passes after each change. It needs a disposable
// Linux host with Docker, because it removes any earlier install first.
// LIBREDB_INSTALLER_BIN names another installer binary than dist/libredb-installer-linux-x64, and
// LIBREDB_E2E_IMAGES_REGISTRY sets images.registry for every run, such as registry.example.com/libredb for images
// that exist only in a registry mirror.
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseComposePs, type ComposeContainer } from "../../src/adapters/docker";
import { NO_RENEWAL_TIMER } from "../../src/steps/base-docker";
import { createCa } from "../../src/tls/ca";
import { LICENSE_ARGS } from "./support/install";

const packageRoot = join(import.meta.dir, "..", "..");
const INSTALLER = process.env.LIBREDB_INSTALLER_BIN ?? join(packageRoot, "dist", "libredb-installer-linux-x64");
const CONFIG = join(packageRoot, "test", "fixtures", "configs", "docker.yaml");
const REGISTRY = process.env.LIBREDB_E2E_IMAGES_REGISTRY;
const INSTALL_ROOT = "/opt/libredb";
const PROJECT = "libredb";
const CA_BUNDLE = join(INSTALL_ROOT, "ca", "ca.crt");
const CA_CERTIFICATE = join(INSTALL_ROOT, "tls", "ca", "ca.crt");
const EDGE_TLS_DIR = join(INSTALL_ROOT, "tls", "edge");
const POSTGRES_LEAF = join(INSTALL_ROOT, "tls", "postgres", "server.crt");
const HOSTS = ["platform.libredb.test", "studio.libredb.test", "auth.libredb.test"];
const TRUSTING = ["edge", "keycloak", "platform", "studio"];
const LONG = 20 * 60_000;

// The customer CA of the first test stays configured in every later run, so the bundle stays as it was.
const scratch = mkdtempSync(join(tmpdir(), "libredb-e2e-tls-"));
const CUSTOMER_CA = join(scratch, "customer-ca.crt");
const BASE_ARGS = [
  "-c",
  CONFIG,
  ...(REGISTRY === undefined || REGISTRY === "" ? [] : ["--set", `images.registry=${REGISTRY}`]),
  ...LICENSE_ARGS,
];
const WITH_CUSTOMER_CA = [...BASE_ARGS, "--set", `tls.caBundleFile=${CUSTOMER_CA}`];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

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
  return { code, stdout, stderr };
}

function containers(): ComposeContainer[] {
  return parseComposePs(sh(["docker", "compose", "-p", PROJECT, "ps", "--all", "--format", "json"]).stdout);
}

/** The container id of every service that runs, by service. */
function containerIds(): Record<string, string> {
  return Object.fromEntries(containers().map((container) => [container.service, container.id]));
}

function label(service: string, name: string): string {
  const id = containerIds()[service];
  if (id === undefined) throw new Error(`the project has no ${service} container`);
  return sh(["docker", "inspect", "--format", `{{index .Config.Labels "${name}"}}`, id]).stdout.trim();
}

/** `openssl x509 -noout -serial` of a certificate file. */
function serialOf(file: string): string {
  return sh(["openssl", "x509", "-noout", "-serial", "-in", file]).stdout.trim();
}

function fingerprintOf(file: string): string {
  return sh(["openssl", "x509", "-noout", "-fingerprint", "-sha256", "-in", file]).stdout.trim();
}

/** Every leaf file of the installation: one per public hostname and the PostgreSQL server's. */
function leafFiles(): string[] {
  const edge = readdirSync(EDGE_TLS_DIR)
    .filter((name) => name.endsWith(".crt"))
    .sort()
    .map((name) => join(EDGE_TLS_DIR, name));
  return [...edge, POSTGRES_LEAF];
}

/** The serial number the edge presents for a hostname on its published port. */
function servedSerial(host: string): string {
  const script =
    `openssl s_client -connect 127.0.0.1:443 -servername ${host} </dev/null 2>/dev/null | openssl x509 -noout -serial`;
  return sh(["sh", "-c", script]).stdout.trim();
}

/** The serial number PostgreSQL presents on the data network, read through its STARTTLS handshake. */
function postgresServedSerial(): string {
  const postgres = containers().find((container) => container.service === "postgres");
  if (postgres === undefined) throw new Error("the project has no postgres container");
  const address = sh([
    "docker",
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks "${PROJECT}_data").IPAddress}}`,
    postgres.id,
  ]).stdout.trim();
  const script =
    `openssl s_client -starttls postgres -connect ${address}:5432 -servername postgres </dev/null 2>/dev/null` +
    " | openssl x509 -noout -serial";
  return sh(["sh", "-c", script]).stdout.trim();
}

function removeEarlierInstall(): void {
  const filter = `label=com.docker.compose.project=${PROJECT}`;
  const ids = (kind: string[]) => sh([...kind, "--filter", filter, "--quiet"]).stdout.split("\n").filter(Boolean);
  const containerIdsFound = ids(["docker", "ps", "--all"]);
  if (containerIdsFound.length > 0) sh(["docker", "rm", "--force", "--volumes", ...containerIdsFound]);
  const networks = ids(["docker", "network", "ls"]);
  if (networks.length > 0) sh(["docker", "network", "rm", ...networks]);
  const volumes = ids(["docker", "volume", "ls"]);
  if (volumes.length > 0) sh(["docker", "volume", "rm", "--force", ...volumes]);
  rmSync(INSTALL_ROOT, { recursive: true, force: true });
}

const systemdRuns = existsSync("/run/systemd/system");
/** What plan prints on a converged host; without systemd, base also warns that no timer renews the certificates. */
const CONVERGED_PLAN = systemdRuns ? "No changes\n" : `No changes\nWarning: ${NO_RENEWAL_TIMER}\n`;

beforeAll(async () => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("the Docker end-to-end tests need root on a disposable Linux host with Docker");
  }
  if (!existsSync(INSTALLER)) throw new Error(`${INSTALLER} does not exist; run bun run build first`);
  removeEarlierInstall();
  const customer = await createCa({ commonName: "Acme root CA (e2e)", now: new Date() });
  writeFileSync(CUSTOMER_CA, customer.certPem);
  const applied = await installer("apply", ...BASE_ARGS, "--yes");
  if (applied.code !== 0) throw new Error(`the first apply exited with ${applied.code}: ${applied.stderr}${applied.stdout}`);
}, LONG);

describe("certificates in Docker mode", () => {
  test(
    "after a caBundleFile is added and apply runs, the platform, studio, keycloak and edge containers are recreated, postgres keeps its id, and verify passes",
    async () => {
      const before = containerIds();
      const applied = await installer("apply", ...WITH_CUSTOMER_CA, "--yes");
      expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: "" });
      expect(applied.stdout).toContain("passed  edge-tls");

      const after = containerIds();
      for (const service of TRUSTING) {
        expect({ service, recreated: after[service] !== before[service] }).toEqual({ service, recreated: true });
      }
      expect(after.postgres).toBe(before.postgres as string);

      const bundle = readFileSync(CA_BUNDLE, "utf8");
      // The internal CA and the customer CA.
      expect(bundle.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
      const bundleSha = createHash("sha256").update(bundle).digest("hex");
      for (const service of TRUSTING) expect({ service, label: label(service, "org.libredb.ca-sha256") }).toEqual({ service, label: bundleSha });

      const verify = await installer("verify", ...WITH_CUSTOMER_CA);
      expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });
      const again = await installer("plan", ...WITH_CUSTOMER_CA);
      expect(again.stdout).toBe(CONVERGED_PLAN);
    },
    LONG,
  );

  test(
    "apply --renew-certificates changes the serial of every leaf and keeps the CA",
    async () => {
      const files = leafFiles();
      expect(files).toHaveLength(HOSTS.length + 1);
      const serials = Object.fromEntries(files.map((file) => [file, serialOf(file)]));
      const caFingerprint = fingerprintOf(CA_CERTIFICATE);
      const before = containerIds();

      const renewed = await installer("apply", ...WITH_CUSTOMER_CA, "--renew-certificates", "--yes");
      expect({ code: renewed.code, stderr: renewed.stderr }).toEqual({ code: 0, stderr: "" });
      expect(renewed.stdout).toContain("apply --renew-certificates re-issues every leaf");
      expect(renewed.stdout).toContain("SELECT pg_reload_conf()");

      for (const file of files) {
        expect({ file, changed: serialOf(file) !== serials[file] }).toEqual({ file, changed: true });
      }
      expect(fingerprintOf(CA_CERTIFICATE)).toBe(caFingerprint);
      for (const host of HOSTS) {
        expect({ host, served: servedSerial(host) }).toEqual({ host, served: serialOf(join(EDGE_TLS_DIR, `${host}.crt`)) });
      }
      expect(postgresServedSerial()).toBe(serialOf(POSTGRES_LEAF));

      // The CA bundle did not change, so only the edge reloads its certificates and PostgreSQL keeps running.
      const after = containerIds();
      expect(after.edge).not.toBe(before.edge as string);
      for (const service of ["postgres", "keycloak", "platform", "studio"]) {
        expect({ service, id: after[service] }).toEqual({ service, id: before[service] });
      }

      const verify = await installer("verify", ...WITH_CUSTOMER_CA);
      expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });
      const status = await installer("status");
      expect(status.code).toBe(0);
      expect(status.stdout).toMatch(/\n  internal CA +expires \S+ +36[45]\d days left\n/);
      for (const name of [...HOSTS, "postgres"]) {
        expect(status.stdout).toMatch(new RegExp(`\\n  ${name.replaceAll(".", "\\.")} +expires \\S+ +82[45] days left\\n`));
      }
    },
    LONG,
  );

  test(
    "apply keeps the installer binary and the applied configuration under /opt/libredb for the renewal timer",
    () => {
      expect(sh(["cmp", INSTALLER, join(INSTALL_ROOT, "bin", "libredb-installer")]).code).toBe(0);
      const applied = readFileSync(join(INSTALL_ROOT, "libredb.yaml"), "utf8");
      expect(applied).toContain(`caBundleFile: ${CUSTOMER_CA}\n`);
      if (REGISTRY !== undefined && REGISTRY !== "") expect(applied).toContain(`registry: ${REGISTRY}\n`);
    },
    LONG,
  );

  test.skipIf(!systemdRuns)(
    "systemctl list-timers libredb-tls-renew.timer lists the timer after an apply on a systemd host",
    () => {
      expect(sh(["systemctl", "list-timers", "--all", "libredb-tls-renew.timer"]).stdout).toContain("libredb-tls-renew.timer");
      expect(sh(["systemctl", "is-enabled", "libredb-tls-renew.timer"]).stdout.trim()).toBe("enabled");
    },
    LONG,
  );
});
