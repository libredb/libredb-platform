// The provided and external TLS modes in Docker mode end to end. The test PKI is a customer's: a root, an
// intermediate under it that issues every leaf, each certificate file holding its leaf and then the intermediate, and
// a CA bundle that holds only the root. With tls.mode provided the edge serves the customer's chain and key per
// hostname; with tls.mode external a test TLS proxy terminates TLS for the three hostnames and forwards plain HTTP to
// the edge, which holds no alias, so containers reach the public URLs through that proxy. In both, apply and verify
// pass, and `tls export-ca` writes the internal CA. It needs a disposable Linux host with Docker and openssl whose
// /etc/hosts maps the three hostnames to 127.0.0.1, because it removes any earlier install first.
// LIBREDB_INSTALLER_BIN names another installer binary than dist/libredb-installer-linux-x64, and
// LIBREDB_E2E_IMAGES_REGISTRY sets images.registry for every run, such as registry.example.com/libredb for images
// that exist only in a registry mirror.
import { beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseComposePs } from "../../src/adapters/docker";
import { NO_RENEWAL_TIMER } from "../../src/steps/base-docker";

const packageRoot = join(import.meta.dir, "..", "..");
const INSTALLER = process.env.LIBREDB_INSTALLER_BIN ?? join(packageRoot, "dist", "libredb-installer-linux-x64");
const configs = join(packageRoot, "test", "fixtures", "configs");
const PROVIDED = join(configs, "docker-provided.yaml");
const EXTERNAL = join(configs, "docker-external-tls.yaml");
const REGISTRY = process.env.LIBREDB_E2E_IMAGES_REGISTRY;
const SETS = REGISTRY === undefined || REGISTRY === "" ? [] : ["--set", `images.registry=${REGISTRY}`];
const INSTALL_ROOT = "/opt/libredb";
const PROJECT = "libredb";
const INTERNAL_CA = join(INSTALL_ROOT, "tls", "ca", "ca.crt");
const EDGE_NETWORK = `${PROJECT}_edge`;
const PROXY = "libredb-e2e-tls-proxy";
// The test TLS proxy's fixed address on the edge network, which docker-external-tls.yaml names in
// tls.external.trustedProxies, and the subnet the network needs for a fixed address.
const EDGE_SUBNET = "10.213.0.0/24";
const PROXY_ADDRESS = "10.213.0.10";
// The directory the fixtures name for the test CA and the provided files.
const MATERIAL = "/var/lib/libredb-e2e/tls-modes";
const HOSTS = ["platform.libredb.test", "studio.libredb.test", "auth.libredb.test"];
const ENDPOINTS = ["platform", "studio", "auth"];
const LONG = 25 * 60_000;
const systemdRuns = existsSync("/run/systemd/system");
/** What plan prints on a converged host; without systemd, base also warns that no timer renews the certificates. */
const CONVERGED_PLAN = systemdRuns ? "No changes\n" : `No changes\nWarning: ${NO_RENEWAL_TIMER}\n`;

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

/** The lines of the checks that failed, so a failure shows its cause. */
function failedChecks(run: RunResult): string[] {
  return run.stdout.split("\n").filter((line) => line.startsWith("failed"));
}

function fingerprintOf(file: string): string {
  return sh(["openssl", "x509", "-noout", "-fingerprint", "-sha256", "-in", file]).stdout.trim();
}

function serialOf(file: string): string {
  return sh(["openssl", "x509", "-noout", "-serial", "-in", file]).stdout.trim();
}

/** The serial number a TLS server on 127.0.0.1:443 presents for a hostname. */
function servedSerial(host: string): string {
  const script =
    `openssl s_client -connect 127.0.0.1:443 -servername ${host} </dev/null 2>/dev/null | openssl x509 -noout -serial`;
  return sh(["sh", "-c", script]).stdout.trim();
}

function removeEarlierInstall(): void {
  sh(["docker", "rm", "--force", PROXY], false);
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

const material = (name: string) => join(MATERIAL, name);

function openssl(...args: string[]): void {
  sh(["openssl", ...args]);
}

/** A new P-256 key in `<name>.key`, readable by root only, and a certificate request for `subject` in `<name>.csr`. */
function keyAndRequest(name: string, subject: string): void {
  const [key, request] = [material(`${name}.key`), material(`${name}.csr`)];
  openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", subject, "-keyout", key, "-out", request);
  chmodSync(key, 0o600);
}

/** Signs `<name>.csr` with the CA certificate `<issuer>.pem` and its key into `<name>.pem`, with these extensions. */
function sign(name: string, issuer: string, days: number, extensions: readonly string[]): void {
  writeFileSync(material(`${name}.ext`), `${extensions.join("\n")}\n`);
  openssl(
    "x509",
    "-req",
    "-in",
    material(`${name}.csr`),
    "-CA",
    material(`${issuer}.pem`),
    "-CAkey",
    material(`${issuer}.key`),
    "-set_serial",
    `0x${randomBytes(8).toString("hex")}`,
    "-days",
    String(days),
    "-extfile",
    material(`${name}.ext`),
    "-out",
    material(`${name}.pem`),
  );
}

/**
 * Writes the customer's PKI with openssl, as a corporate CA issues it: a root, an intermediate that the root issues,
 * and from the intermediate a leaf per endpoint and one for the proxy's three hostnames. Each `<name>.crt` holds the
 * leaf and then the intermediate, and the CA bundle `ca.crt` holds only the root.
 */
function writeCustomerPki(): void {
  openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-subj",
    "/CN=Acme root CA (e2e TLS modes)",
    "-days",
    "3650",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    material("root.key"),
    "-out",
    material("root.pem"),
  );
  writeFileSync(material("ca.crt"), readFileSync(material("root.pem")));
  keyAndRequest("intermediate", "/CN=Acme issuing CA (e2e TLS modes)");
  sign("intermediate", "root", 1825, [
    "basicConstraints=critical,CA:TRUE,pathlen:0",
    "keyUsage=critical,keyCertSign,cRLSign",
    "subjectKeyIdentifier=hash",
    "authorityKeyIdentifier=keyid",
  ]);
  const leaves = [...ENDPOINTS.map((endpoint, index) => ({ name: endpoint, hosts: [HOSTS[index] as string] })), { name: "proxy", hosts: HOSTS }];
  for (const { name, hosts } of leaves) {
    keyAndRequest(name, `/CN=${hosts[0]}`);
    sign(name, "intermediate", 397, [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}`,
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid",
    ]);
    const chain = readFileSync(material(`${name}.pem`), "utf8") + readFileSync(material("intermediate.pem"), "utf8");
    writeFileSync(material(`${name}.crt`), chain, { mode: 0o644 });
  }
}

/** The release's edge image, which the test TLS proxy runs as well. */
async function caddyImage(): Promise<string> {
  const listed = await installer("images", "list", "-c", EXTERNAL, ...SETS);
  if (listed.code !== 0) throw new Error(`images list exited with ${listed.code}: ${listed.stderr}`);
  const image = listed.stdout.split("\n").find((line) => line.includes("/caddy@"));
  if (image === undefined) throw new Error(`the release has no caddy image:\n${listed.stdout}`);
  return image;
}

/**
 * Starts the test TLS proxy at PROXY_ADDRESS on the edge network with the three hostnames as its aliases and 443
 * published, as a customer's proxy that DNS names for them. The network is created first with the labels Compose
 * adopts, because the preflight probes the hosts from inside it before the base step runs.
 */
async function startProxy(): Promise<void> {
  sh([
    "docker",
    "network",
    "create",
    "--subnet",
    EDGE_SUBNET,
    "--label",
    `com.docker.compose.project=${PROJECT}`,
    "--label",
    "com.docker.compose.network=edge",
    EDGE_NETWORK,
  ]);
  const caddyfile = [
    "{",
    "\tauto_https off",
    "}",
    "",
    `${HOSTS.map((host) => `https://${host}`).join(", ")} {`,
    "\ttls /etc/proxy/proxy.crt /etc/proxy/proxy.key",
    "\treverse_proxy edge:8080",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(MATERIAL, "Caddyfile"), caddyfile);
  sh([
    "docker",
    "run",
    "--detach",
    "--name",
    PROXY,
    "--network",
    EDGE_NETWORK,
    "--ip",
    PROXY_ADDRESS,
    ...HOSTS.flatMap((host) => ["--network-alias", host]),
    "--publish",
    "443:443",
    "--volume",
    `${MATERIAL}:/etc/proxy:ro`,
    await caddyImage(),
    "caddy",
    "run",
    "--config",
    "/etc/proxy/Caddyfile",
    "--adapter",
    "caddyfile",
  ]);
}

beforeAll(() => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("the Docker end-to-end tests need root on a disposable Linux host with Docker");
  }
  if (!existsSync(INSTALLER)) throw new Error(`${INSTALLER} does not exist; run bun run build first`);
  rmSync(MATERIAL, { recursive: true, force: true });
  mkdirSync(MATERIAL, { recursive: true, mode: 0o755 });
  writeCustomerPki();
}, LONG);

describe("TLS modes in Docker mode", () => {
  test(
    "with tls.mode provided and leaves from an intermediate whose root alone is in the CA bundle, apply and verify pass",
    async () => {
      removeEarlierInstall();
      const refused = await installer(
        "apply",
        "-c",
        PROVIDED,
        ...SETS,
        "--set",
        `tls.provided.platform.keyFile=${join(MATERIAL, "studio.key")}`,
        "--yes",
      );
      expect(refused.code).toBe(3);
      expect(refused.stderr).toContain(
        `tls.provided: the key in ${join(MATERIAL, "studio.key")} does not match the certificate in ${join(MATERIAL, "platform.crt")}`,
      );

      const applied = await installer("apply", "-c", PROVIDED, ...SETS, "--yes");
      expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: "" });
      expect(applied.stdout).toContain("passed  edge-tls");
      for (const [index, host] of HOSTS.entries()) {
        const provided = join(MATERIAL, `${ENDPOINTS[index]}.crt`);
        expect({ host, served: servedSerial(host) }).toEqual({ host, served: serialOf(provided) });
      }

      const verify = await installer("verify", "-c", PROVIDED, ...SETS);
      expect({ code: verify.code, stderr: verify.stderr, failed: failedChecks(verify) }).toEqual({ code: 0, stderr: "", failed: [] });
      const again = await installer("plan", "-c", PROVIDED, ...SETS);
      expect(again.stdout).toBe(CONVERGED_PLAN);

      const exported = join(MATERIAL, "exported-ca.crt");
      const exportCa = await installer("tls", "export-ca", "-o", exported);
      expect({ code: exportCa.code, stderr: exportCa.stderr }).toEqual({ code: 0, stderr: "" });
      expect(fingerprintOf(exported)).toBe(fingerprintOf(INTERNAL_CA));
      expect(fingerprintOf(exported)).not.toBe(fingerprintOf(join(MATERIAL, "ca.crt")));
      expect(readFileSync(exported, "utf8")).not.toContain("PRIVATE KEY");

      // As root, export-ca replaces an existing file only with --force, never follows a symbolic link at -o, and gives a
      // new file mode 0644 whatever the umask.
      const existing = await installer("tls", "export-ca", "-o", exported);
      expect({ code: existing.code, stderr: existing.stderr }).toEqual({
        code: 2,
        stderr: `tls export-ca: ${exported} already exists; pass --force to replace it\n`,
      });
      expect((await installer("tls", "export-ca", "-o", exported, "--force")).code).toBe(0);
      const canary = join(MATERIAL, "canary");
      writeFileSync(canary, "canary\n", { mode: 0o600 });
      const planted = join(MATERIAL, "planted-ca.crt");
      sh(["ln", "-s", canary, planted]);
      const followed = await installer("tls", "export-ca", "-o", planted);
      expect({ code: followed.code, stderr: followed.stderr }).toEqual({
        code: 2,
        stderr: `tls export-ca: ${planted} is a symbolic link, which the installer never follows; pass --force to replace the link itself\n`,
      });
      const replaced = await installer("tls", "export-ca", "-o", planted, "--force");
      expect({ code: replaced.code, stderr: replaced.stderr }).toEqual({ code: 0, stderr: "" });
      expect(sh(["stat", "-c", "%F %a", planted]).stdout).toBe("regular file 644\n");
      expect(fingerprintOf(planted)).toBe(fingerprintOf(INTERNAL_CA));
      expect({ content: readFileSync(canary, "utf8"), mode: sh(["stat", "-c", "%a", canary]).stdout }).toEqual({
        content: "canary\n",
        mode: "600\n",
      });
      const narrowed = join(MATERIAL, "exported-ca-umask.crt");
      sh(["sh", "-c", 'umask 077 && exec "$0" tls export-ca -o "$1"', INSTALLER, narrowed]);
      expect(sh(["stat", "-c", "%a", narrowed]).stdout).toBe("644\n");

      // A symbolic link among the directories of -o, a directory that another uid owns and one that group or others can
      // write to without the sticky bit are refused, while a sticky directory that everyone can write to, as /tmp, is not.
      const linked = join(MATERIAL, "linked");
      sh(["ln", "-s", MATERIAL, linked]);
      const throughLink = await installer("tls", "export-ca", "-o", join(linked, "linked-ca.crt"));
      expect({ code: throughLink.code, stderr: throughLink.stderr }).toEqual({
        code: 2,
        stderr: `tls export-ca: ${join(linked, "linked-ca.crt")} must not contain a symbolic link; it resolves to ${join(MATERIAL, "linked-ca.crt")}, so pass that instead\n`,
      });
      // A directory that another uid owns is refused, unless that uid is the operator who ran sudo, whose uid SUDO_UID
      // holds. SUDO_UID is set or unset explicitly here, because these tests may themselves run under sudo.
      const foreign = join(MATERIAL, "foreign");
      sh(["install", "-d", "-o", "4242", "-m", "0755", foreign]);
      const exportAs = (sudoUid: string[]) => sh(["env", ...sudoUid, INSTALLER, "tls", "export-ca", "-o", join(foreign, "ca.crt")], false);
      const foreignRun = exportAs(["-u", "SUDO_UID"]);
      expect({ code: foreignRun.code, stderr: foreignRun.stderr }).toEqual({
        code: 2,
        stderr: `tls export-ca: ${foreign} is owned by uid 4242, and every directory of the path must be owned by root\n`,
      });
      const notNumeric = exportAs(["SUDO_UID=4242abc"]);
      expect({ code: notNumeric.code, stderr: notNumeric.stderr }).toEqual({
        code: 2,
        stderr: `tls export-ca: ${foreign} is owned by uid 4242, and every directory of the path must be owned by root\n`,
      });
      const otherOperator = exportAs(["SUDO_UID=4243"]);
      expect({ code: otherOperator.code, stderr: otherOperator.stderr }).toEqual({
        code: 2,
        stderr: `tls export-ca: ${foreign} is owned by uid 4242, and every directory of the path must be owned by root or uid 4243, which ran sudo\n`,
      });
      const operator = exportAs(["SUDO_UID=4242"]);
      expect({ code: operator.code, stderr: operator.stderr }).toEqual({ code: 0, stderr: "" });
      expect(fingerprintOf(join(foreign, "ca.crt"))).toBe(fingerprintOf(INTERNAL_CA));
      const shared = join(MATERIAL, "shared");
      sh(["install", "-d", "-m", "0777", shared]);
      const sharedRun = await installer("tls", "export-ca", "-o", join(shared, "ca.crt"));
      expect({ code: sharedRun.code, stderr: sharedRun.stderr }).toEqual({
        code: 2,
        stderr: `tls export-ca: ${shared} is writable by its group and others without the sticky bit, so another user could redirect the path; run chmod go-w ${shared}, or name a path below a root-owned directory such as /root\n`,
      });
      const sticky = join(MATERIAL, "sticky");
      sh(["install", "-d", "-m", "1777", sticky]);
      expect((await installer("tls", "export-ca", "-o", join(sticky, "ca.crt"))).code).toBe(0);
      expect(fingerprintOf(join(sticky, "ca.crt"))).toBe(fingerprintOf(INTERNAL_CA));
    },
    LONG,
  );

  test(
    "with tls.mode external behind a test TLS proxy, apply and verify pass",
    async () => {
      removeEarlierInstall();
      await startProxy();
      try {
        const applied = await installer("apply", "-c", EXTERNAL, ...SETS, "--yes");
        expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: "" });
        expect(applied.stdout).toContain("passed  edge-tls");

        const verify = await installer("verify", "-c", EXTERNAL, ...SETS);
        expect({ code: verify.code, stderr: verify.stderr, failed: failedChecks(verify) }).toEqual({ code: 0, stderr: "", failed: [] });
        const again = await installer("plan", "-c", EXTERNAL, ...SETS);
        expect(again.stdout).toBe(CONVERGED_PLAN);

        // The edge publishes plain HTTP on 8080 and holds no alias; the proxy serves the test CA's leaf.
        const edge = parseComposePs(
          sh(["docker", "compose", "-p", PROJECT, "ps", "--all", "--format", "json"]).stdout,
        ).find((container) => container.service === "edge");
        if (edge === undefined) throw new Error("the project has no edge container");
        const aliases = sh([
          "docker",
          "inspect",
          "--format",
          `{{json (index .NetworkSettings.Networks "${EDGE_NETWORK}").Aliases}}`,
          edge.id,
        ]).stdout;
        for (const host of HOSTS) expect(aliases).not.toContain(host);
        expect(sh(["docker", "port", edge.id]).stdout).toContain("8080/tcp -> 0.0.0.0:8080");
        // The edge passes X-Forwarded-* on from the proxy's address alone, which the configuration names.
        expect(readFileSync(join(INSTALL_ROOT, "edge", "Caddyfile"), "utf8")).toContain(
          `\t\ttrusted_proxies static ${PROXY_ADDRESS}/32\n`,
        );
        for (const host of HOSTS) expect({ host, served: servedSerial(host) }).toEqual({ host, served: serialOf(join(MATERIAL, "proxy.crt")) });

        const exported = join(MATERIAL, "exported-ca-external.crt");
        expect((await installer("tls", "export-ca", "-o", exported)).code).toBe(0);
        expect(fingerprintOf(exported)).toBe(fingerprintOf(INTERNAL_CA));

        // Without the proxy the public hosts do not resolve from inside the edge network.
        sh(["docker", "stop", PROXY]);
        const preflight = await installer("preflight", "-c", EXTERNAL, ...SETS);
        expect(preflight.code).toBe(3);
        expect(preflight.stderr).toContain("platform.libredb.test does not resolve from inside the edge network");
      } finally {
        sh(["docker", "rm", "--force", PROXY], false);
      }
    },
    LONG,
  );
});
