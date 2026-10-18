// The ports endpoint style in Docker mode end to end: the compiled installer applies
// test/fixtures/configs/docker-ports.yaml as root under /opt/libredb, which serves Platform, Studio and Keycloak on the
// one host lab.libredb.test on 443, 8443 and 9443. The edge presents one leaf on every port, Studio sends the browser
// to the issuer with a callback that keeps its port, verify passes and a second plan changes nothing. It needs a
// disposable Linux host with Docker that resolves lab.libredb.test to itself, because it removes any earlier install
// first. LIBREDB_INSTALLER_BIN names another installer binary than dist/libredb-installer-linux-x64, and
// LIBREDB_E2E_IMAGES_REGISTRY sets images.registry for every run, such as registry.example.com/libredb for images
// that exist only in a registry mirror.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NO_RENEWAL_TIMER } from "../../src/steps/base-docker";
import { LICENSE_ARGS } from "./support/install";

const packageRoot = join(import.meta.dir, "..", "..");
const INSTALLER = process.env.LIBREDB_INSTALLER_BIN ?? join(packageRoot, "dist", "libredb-installer-linux-x64");
const CONFIG = join(packageRoot, "test", "fixtures", "configs", "docker-ports.yaml");
const REGISTRY = process.env.LIBREDB_E2E_IMAGES_REGISTRY;
const INSTALL_ROOT = "/opt/libredb";
const PROJECT = "libredb";
const CA_BUNDLE = join(INSTALL_ROOT, "ca", "ca.crt");
const EDGE_TLS_DIR = join(INSTALL_ROOT, "tls", "edge");
const HOST = "lab.libredb.test";
const PORTS = { platform: 443, studio: 8443, auth: 9443 };
const STUDIO_URL = `https://${HOST}:${PORTS.studio}`;
const ISSUER = `https://${HOST}:${PORTS.auth}/realms/libredb`;
const STUDIO_CALLBACK = `${STUDIO_URL}/api/auth/oidc/callback`;
const LONG = 20 * 60_000;
const systemdRuns = existsSync("/run/systemd/system");
/** What plan prints on a converged host; without systemd, base also warns that no timer renews the certificates. */
const CONVERGED_PLAN = systemdRuns ? "No changes\n" : `No changes\nWarning: ${NO_RENEWAL_TIMER}\n`;

const ARGS = [
  "-c",
  CONFIG,
  ...(REGISTRY === undefined || REGISTRY === "" ? [] : ["--set", `images.registry=${REGISTRY}`]),
  ...LICENSE_ARGS,
];

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

/** A request from the host to a public URL, trusting the installation's CA bundle and following no redirect. */
function fetchPublic(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual", tls: { ca: readFileSync(CA_BUNDLE, "utf8") } });
}

/** The serial number the edge presents for the host on one of its published ports. */
function servedSerial(port: number): string {
  const script =
    `openssl s_client -connect 127.0.0.1:${port} -servername ${HOST} </dev/null 2>/dev/null | openssl x509 -noout -serial`;
  return sh(["sh", "-c", script]).stdout.trim();
}

let firstApply: RunResult;

beforeAll(async () => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("the Docker end-to-end tests need root on a disposable Linux host with Docker");
  }
  if (!existsSync(INSTALLER)) throw new Error(`${INSTALLER} does not exist; run bun run build first`);
  removeEarlierInstall();
  firstApply = await installer("apply", ...ARGS, "--yes");
  if (firstApply.code !== 0) {
    throw new Error(`the first apply exited with ${firstApply.code}: ${firstApply.stderr}${firstApply.stdout}`);
  }
}, LONG);

describe("the ports endpoint style in Docker mode", () => {
  test(
    `studio-oidc-chain passes with redirect_uri ${STUDIO_CALLBACK}`,
    async () => {
      const verify = await installer("verify", ...ARGS, "--output", "json");
      expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });
      const { checks } = JSON.parse(verify.stdout) as { checks: { id: string; result: string; cause: string | null }[] };
      for (const id of ["studio-oidc-chain", "oidc-discovery-in-network", "edge-tls"]) {
        expect(checks.find((check) => check.id === id)).toEqual({ id, result: "passed", cause: null });
      }

      // The same chain from the host, as a browser takes it: Studio sends it to the issuer on 9443 with its callback
      // on 8443.
      const login = await fetchPublic(`${STUDIO_URL}/api/auth/oidc/login`);
      expect(login.status).toBe(307);
      const authorize = new URL(login.headers.get("location") ?? "");
      expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/protocol/openid-connect/auth`);
      expect(authorize.searchParams.get("client_id")).toBe("libredb-studio");
      expect(authorize.searchParams.get("redirect_uri")).toBe(STUDIO_CALLBACK);
      const form = await fetchPublic(authorize.href);
      expect(form.status).toBe(200);

      const discovery = await fetchPublic(`${ISSUER}/.well-known/openid-configuration`);
      expect(((await discovery.json()) as { issuer?: string }).issuer).toBe(ISSUER);
    },
    LONG,
  );

  test(
    "the edge presents the one leaf of the host on 443, 8443 and 9443",
    () => {
      const leaves = readdirSync(EDGE_TLS_DIR).filter((name) => name.endsWith(".crt"));
      expect(leaves).toEqual([`${HOST}.crt`]);
      const serial = sh(["openssl", "x509", "-noout", "-serial", "-in", join(EDGE_TLS_DIR, `${HOST}.crt`)]).stdout.trim();
      for (const port of Object.values(PORTS)) expect({ port, served: servedSerial(port) }).toEqual({ port, served: serial });
    },
    LONG,
  );

  test(
    "the report prints the URLs with their ports and states that the apps share cookies and HSTS, and a second plan changes nothing",
    async () => {
      expect(firstApply.stdout).toContain(`  Platform  https://${HOST}\n`);
      expect(firstApply.stdout).toContain(`  Studio    ${STUDIO_URL}\n`);
      expect(firstApply.stdout).toContain(`  Auth      https://${HOST}:${PORTS.auth}\n`);
      expect(firstApply.stdout).toContain("so the apps share cookies and HSTS");
      const plan = await installer("plan", ...ARGS);
      expect({ code: plan.code, stdout: plan.stdout }).toEqual({ code: 0, stdout: CONVERGED_PLAN });
    },
    LONG,
  );
});
