// Network egress of R11 in Docker mode: once the images are pulled, no packet from a container on one of
// the installation's networks reaches an address outside the private ranges, during apply, verify and the interop
// suite (e2e/interop.spec.ts). The test applies test/fixtures/configs/docker.yaml up to the base step, which pulls every
// image and creates the networks, then jumps from the DOCKER-USER chain to a chain of its own for every subnet of those
// networks. That chain returns packets to private, loopback and link-local destinations and counts and drops every
// other, so a container that tried to reach the internet both fails and moves the counter, which must stay at 0. A
// probe to a public address at the end proves the counter counts.
// It needs root on a disposable Linux host whose Docker Engine manages iptables, with the .test hostnames mapped to
// the host as the browser specs need them. It leaves the installation in place for the specs that run after it, and
// removes its iptables rules. LIBREDB_E2E_INTEROP_COMMAND replaces the command that runs the interop suite, which is
// `bunx playwright test --config e2e/playwright.config.ts --project=hostnames interop.spec.ts` in the package root.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CATALOGUE } from "../../src/verify/catalogue";
import {
  failedChecks,
  installer,
  LICENSE_ARGS,
  PACKAGE_ROOT,
  PROJECT,
  REGISTRY_ARGS,
  removeInstall,
  requireDisposableHost,
  sh,
  VERIFIED,
  type VerifyReport,
} from "./support/install";

const CONFIG_ARGS = ["-c", join(PACKAGE_ROOT, "test", "fixtures", "configs", "docker.yaml"), ...REGISTRY_ARGS, ...LICENSE_ARGS];
const CHAIN = "LIBREDB-E2E-EGRESS";
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16"];
// A public address of the probe, which documentation reserves (RFC 5737), so even a missing rule reaches nobody.
const PUBLIC_PROBE = "192.0.2.1";
const INTEROP_COMMAND =
  process.env.LIBREDB_E2E_INTEROP_COMMAND ??
  "bunx playwright test --config e2e/playwright.config.ts --project=hostnames interop.spec.ts";
const LONG = 45 * 60_000;

/** The IPv4 subnets of the project's networks, by network name. */
function projectSubnets(): Map<string, string[]> {
  const label = `label=com.docker.compose.project=${PROJECT}`;
  const names = sh(["docker", "network", "ls", "--filter", label, "--format", "{{.Name}}"]).stdout.split("\n").filter(Boolean);
  const subnets = new Map<string, string[]>();
  for (const name of names.sort()) {
    const config = JSON.parse(
      sh(["docker", "network", "inspect", "--format", "{{json .IPAM.Config}}", name]).stdout,
    ) as { Subnet: string }[];
    const ipv6 = config.filter((entry) => entry.Subnet.includes(":"));
    // The chain is IPv4 only, so an IPv6 subnet would leave a route out unobserved.
    if (ipv6.length > 0) throw new Error(`network ${name} has an IPv6 subnet, which this test does not observe`);
    subnets.set(name, config.map((entry) => entry.Subnet));
  }
  return subnets;
}

function removeRules(): void {
  // Each jump is deleted until none is left; iptables -D exits non-zero once no rule matches.
  const rules = sh(["iptables", "-S", "DOCKER-USER"], false).stdout.split("\n");
  for (const rule of rules.filter((line) => line.includes(`-j ${CHAIN}`))) {
    sh(["iptables", ...rule.replace(/^-A /, "-D ").split(" ")]);
  }
  if (sh(["iptables", "-S", CHAIN], false).code === 0) {
    sh(["iptables", "-F", CHAIN]);
    sh(["iptables", "-X", CHAIN]);
  }
}

function installRules(subnets: Map<string, string[]>): void {
  if (sh(["iptables", "-S", "DOCKER-USER"], false).code !== 0) {
    throw new Error("iptables has no DOCKER-USER chain; the Docker Engine must manage iptables for this test");
  }
  sh(["iptables", "-N", CHAIN]);
  for (const range of PRIVATE_RANGES) sh(["iptables", "-A", CHAIN, "-d", range, "-j", "RETURN"]);
  sh(["iptables", "-A", CHAIN, "-j", "DROP"]);
  for (const subnet of [...subnets.values()].flat()) sh(["iptables", "-I", "DOCKER-USER", "-s", subnet, "-j", CHAIN]);
}

/** The packets the chain's DROP rule counted. */
function droppedPackets(): number {
  const listing = sh(["iptables", "-L", CHAIN, "-n", "-v", "-x"]).stdout.split("\n");
  const drop = listing.find((line) => /^\s*\d+\s+\d+\s+DROP\b/.test(line));
  if (drop === undefined) throw new Error(`the chain ${CHAIN} has no DROP rule:\n${listing.join("\n")}`);
  return Number(drop.trim().split(/\s+/)[0]);
}

beforeAll(() => {
  requireDisposableHost();
  removeRules();
  removeInstall(["libredb-e2e-target"]);
});

afterAll(() => {
  removeRules();
});

describe("network egress in Docker mode", () => {
  test(
    "no packet leaves the libredb networks during apply, verify and the interop suite",
    async () => {
      const pulled = await installer(["apply", ...CONFIG_ARGS, "--only", "preflight,images,secrets,tls,base", "--yes"]);
      expect({ code: pulled.code, stderr: pulled.stderr }).toEqual({ code: 0, stderr: "" });
      const subnets = projectSubnets();
      expect([...subnets.keys()]).toEqual([`${PROJECT}_data`, `${PROJECT}_edge`]);
      installRules(subnets);
      expect(droppedPackets()).toBe(0);

      const applied = await installer(["apply", ...CONFIG_ARGS, "--yes"]);
      expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: "" });
      expect(applied.stdout).toContain(VERIFIED);
      const verify = await installer(["verify", ...CONFIG_ARGS, "--output", "json"]);
      const report = JSON.parse(verify.stdout) as VerifyReport;
      expect(report.checks.map((check) => check.id)).toEqual(CATALOGUE.map((check) => check.id));
      expect(failedChecks(report)).toEqual([]);
      expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });

      const interop = Bun.spawnSync(["sh", "-c", INTEROP_COMMAND], {
        cwd: PACKAGE_ROOT,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      expect({ interop: INTEROP_COMMAND, code: interop.exitCode }).toEqual({ interop: INTEROP_COMMAND, code: 0 });

      // No network appeared that the rules do not watch.
      expect(projectSubnets()).toEqual(subnets);
      expect(droppedPackets()).toBe(0);

      // The probe: a container on libredb_edge tries a public address, which the chain must count and drop.
      const image = sh(["docker", "inspect", "--format", "{{.Config.Image}}", `${PROJECT}-postgres-1`]).stdout.trim();
      const probe = sh(
        ["docker", "run", "--rm", "--network", `${PROJECT}_edge`, "--entrypoint", "pg_isready", image, "-h", PUBLIC_PROBE, "-t", "3"],
        false,
      );
      expect(probe.code).not.toBe(0);
      expect(droppedPackets()).toBeGreaterThan(0);
    },
    LONG,
  );
});
