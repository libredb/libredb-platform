import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../../../src/cli/exit-codes";
import {
  checkDockerHost,
  compareVersions,
  type DockerHostObservation,
  type PortObservation,
  parseSsListeners,
  publishedPorts,
  PreflightError,
  requiredHostTools,
} from "../../../src/preflight/docker-checks";
import { parseReleaseManifest, type ReleaseManifest } from "../../../src/release/manifest";
import { renderCompose } from "../../../src/render/compose";
import { manifestFixture } from "../release/fixture";
import { desiredFixture, TRUST_FIXTURE } from "../render/fixture";

const MINIMUMS = manifestFixture().minimums;

/** The minimums of the committed release config, which the binary embeds. */
function releaseMinimums(): ReleaseManifest["minimums"] {
  const raw: unknown = JSON.parse(readFileSync(join(import.meta.dir, "../../../release/release.config.json"), "utf8"));
  return parseReleaseManifest(raw).minimums;
}

/** The problem preflight names for a Docker Engine release that GHSA-x4rx-4gw3-53p4 affects. */
function advisoryProblem(version: string): string {
  return (
    `Docker Engine ${version} is affected by GHSA-x4rx-4gw3-53p4 (CVE-2025-54388): after a firewalld reload, a remote ` +
    "host with a route to a Docker bridge network can reach the published ports, even those published to 127.0.0.1, " +
    "so upgrade Docker Engine to 28.3.3 or newer"
  );
}

const EDGE = { name: "libredb-edge-1", project: "libredb", service: "edge" };

function freePort(port: number): PortObservation {
  return { port, listeners: [], containers: [] };
}

function observation(overrides: Partial<DockerHostObservation> = {}): DockerHostObservation {
  return {
    platform: "linux",
    uid: 0,
    dockerEngine: { found: true, version: "27.3.1" },
    compose: { found: true, version: "2.29.7" },
    missingTools: [],
    ports: [freePort(443)],
    ...overrides,
  };
}

const SS_MISSING =
  "ss is not on the PATH, and preflight needs it to find what holds each port the installation publishes; it comes with iproute2";
const SYSTEMCTL_MISSING = "systemctl is not on the PATH, and docker.systemdUnit: true needs it to install and enable libredb.service";

function failure(observed: DockerHostObservation, minimums: ReleaseManifest["minimums"] = MINIMUMS): PreflightError {
  let caught: unknown;
  try {
    checkDockerHost(observed, minimums);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreflightError);
  const error = caught as PreflightError;
  expect(error.exitCode).toBe(ExitCode.PreflightFailed);
  expect(error.exitCode).toBe(3);
  return error;
}

describe("checkDockerHost", () => {
  test("a Linux root host with current Docker, the Compose plugin and free ports passes", () => {
    expect(() => checkDockerHost(observation(), MINIMUMS)).not.toThrow();
  });

  test("versions at exactly the manifest minimums pass", () => {
    const observed = observation({
      dockerEngine: { found: true, version: "24.0.0" },
      compose: { found: true, version: "2.24.0" },
    });
    expect(() => checkDockerHost(observed, MINIMUMS)).not.toThrow();
  });

  test("Docker Engine below the manifest minimum fails with exit 3 naming both versions", () => {
    const error = failure(observation({ dockerEngine: { found: true, version: "20.10.24" } }));
    expect(error.problems).toEqual(["Docker Engine 20.10.24 is older than the required 24.0.0"]);
    expect(error.message).toContain("20.10.24");
    expect(error.message).toContain("24.0.0");
  });

  test("Docker Engine that is missing or unreachable fails naming what was found", () => {
    const error = failure(
      observation({
        dockerEngine: { found: false, detail: "Cannot connect to the Docker daemon" },
        compose: { found: true, version: "2.29.7" },
      }),
    );
    expect(error.problems).toEqual([
      "Docker Engine 24.0.0 or newer is required, and none answered: Cannot connect to the Docker daemon",
    ]);
  });

  test("Docker Engine 28.2.0 through 28.3.2 fails with exit 3 naming GHSA-x4rx-4gw3-53p4, whatever the manifest minimum", () => {
    for (const version of ["28.2.0", "28.2.2", "28.3.0", "28.3.2"]) {
      const error = failure(observation({ dockerEngine: { found: true, version } }));
      expect(error.problems).toEqual([advisoryProblem(version)]);
    }
    for (const version of ["28.1.1", "28.3.3"]) {
      expect(() => checkDockerHost(observation({ dockerEngine: { found: true, version } }), MINIMUMS)).not.toThrow();
    }
  });

  test("Compose v1 without the v2 plugin fails with exit 3 naming the plugin", () => {
    const error = failure(
      observation({
        compose: { found: false, detail: "docker: 'compose' is not a docker command.", legacyVersion: "1.29.2" },
      }),
    );
    expect(error.problems).toEqual([
      "the Docker Compose v2 plugin (docker compose) 2.24.0 or newer is required, and only the legacy docker-compose 1.29.2 was found",
    ]);
  });

  test("a missing Compose plugin without a legacy binary names the plugin and what docker said", () => {
    const error = failure(observation({ compose: { found: false, detail: "'compose' is not a docker command" } }));
    expect(error.problems).toEqual([
      "the Docker Compose v2 plugin (docker compose) 2.24.0 or newer is required, and it is missing: 'compose' is not a docker command",
    ]);
  });

  test("a Compose plugin below the minimum fails naming both versions", () => {
    const error = failure(observation({ compose: { found: true, version: "2.20.2" } }));
    expect(error.problems).toEqual(["the Docker Compose plugin 2.20.2 is older than the required 2.24.0"]);
  });

  test("a published port bound by another process fails with exit 3 naming the port", () => {
    const error = failure(observation({ ports: [{ port: 443, listeners: ["nginx"], containers: [] }] }));
    expect(error.problems).toEqual(["port 443, which the installation publishes, is already in use by nginx"]);
  });

  test("a listener whose process ss could not name is reported as an unknown process", () => {
    const error = failure(observation({ ports: [{ port: 443, listeners: [""], containers: [] }] }));
    expect(error.problems).toEqual([
      "port 443, which the installation publishes, is already in use by an unknown process",
    ]);
  });

  test("a published port held by another container fails naming the container", () => {
    const error = failure(
      observation({
        ports: [
          {
            port: 443,
            listeners: ["docker-proxy"],
            containers: [{ name: "traefik", project: "", service: "" }],
          },
        ],
      }),
    );
    expect(error.problems).toEqual([
      "port 443, which the installation publishes, is already in use by container traefik",
    ]);
  });

  test("a docker-proxy listener that no running container explains fails", () => {
    const error = failure(observation({ ports: [{ port: 443, listeners: ["docker-proxy"], containers: [] }] }));
    expect(error.problems).toEqual(["port 443, which the installation publishes, is already in use by docker-proxy"]);
  });

  test("port 443 held by the libredb edge container passes", () => {
    const observed = observation({ ports: [{ port: 443, listeners: ["docker-proxy"], containers: [EDGE] }] });
    expect(() => checkDockerHost(observed, MINIMUMS)).not.toThrow();
  });

  test("the loopback admin port held by the libredb keycloak container passes", () => {
    const keycloak = { name: "libredb-keycloak-1", project: "libredb", service: "keycloak" };
    const observed = observation({ ports: [{ port: 18080, listeners: ["docker-proxy"], containers: [keycloak] }] });
    expect(() => checkDockerHost(observed, MINIMUMS)).not.toThrow();
  });

  test("an unnamed listener next to the libredb edge container is taken as its docker-proxy", () => {
    const observed = observation({ ports: [{ port: 443, listeners: [""], containers: [EDGE] }] });
    expect(() => checkDockerHost(observed, MINIMUMS)).not.toThrow();
  });

  test("the edge service of another Compose project does not count as this installation's edge", () => {
    const error = failure(
      observation({
        ports: [
          {
            port: 443,
            listeners: ["docker-proxy"],
            containers: [{ name: "other-edge-1", project: "other", service: "edge" }],
          },
        ],
      }),
    );
    expect(error.problems).toEqual([
      "port 443, which the installation publishes, is already in use by container other-edge-1",
    ]);
  });

  test("a run without root fails with exit 3", () => {
    const error = failure(observation({ uid: 1000 }));
    expect(error.problems).toEqual(["the installer must run as root, and it runs as uid 1000"]);
  });

  test("a host other than Linux fails naming the platform", () => {
    const error = failure(observation({ platform: "darwin" }));
    expect(error.problems).toEqual(["Docker mode needs a Linux host, and this one is darwin"]);
  });

  test("every problem is reported at once, one per line", () => {
    const error = failure(
      observation({
        uid: 1000,
        dockerEngine: { found: true, version: "23.0.6" },
        ports: [{ port: 443, listeners: ["nginx"], containers: [] }],
      }),
    );
    expect(error.problems).toHaveLength(3);
    expect(error.message).toBe(
      [
        "preflight failed:",
        "  the installer must run as root, and it runs as uid 1000",
        "  Docker Engine 23.0.6 is older than the required 24.0.0",
        "  port 443, which the installation publishes, is already in use by nginx",
      ].join("\n"),
    );
    expect(error.name).toBe("PreflightError");
  });

  test("a version that does not start with MAJOR.MINOR fails naming it", () => {
    const error = failure(observation({ dockerEngine: { found: true, version: "dev" } }));
    expect(error.problems).toEqual(["Docker Engine reported the version 'dev', which is not a version number"]);
  });

  test("a host without ss on the PATH fails with exit 3 naming ss, and without systemctl naming it too", () => {
    expect(failure(observation({ missingTools: ["ss"], ports: [] })).problems).toEqual([SS_MISSING]);
    expect(failure(observation({ missingTools: ["systemctl"] })).problems).toEqual([SYSTEMCTL_MISSING]);
    expect(failure(observation({ uid: 1000, missingTools: ["ss", "systemctl"], ports: [] })).problems).toEqual([
      "the installer must run as root, and it runs as uid 1000",
      SS_MISSING,
      SYSTEMCTL_MISSING,
    ]);
  });
});

describe("checkDockerHost with the minimums of the committed release config", () => {
  const engine = (version: string) => observation({ dockerEngine: { found: true, version } });

  test("Docker Engine 28.0.4, which GitHub's ubuntu-24.04 runners ship, 28.1.1 and 28.3.3 pass", () => {
    for (const version of ["28.0.4", "28.1.1", "28.3.3"]) {
      expect(() => checkDockerHost(engine(version), releaseMinimums())).not.toThrow();
    }
  });

  test("Docker Engine 28.2.0 and 28.3.2 fail with exit 3 naming GHSA-x4rx-4gw3-53p4 (CVE-2025-54388) and 28.3.3", () => {
    for (const version of ["28.2.0", "28.3.2"]) {
      const error = failure(engine(version), releaseMinimums());
      expect(error.problems).toEqual([advisoryProblem(version)]);
      expect(error.message).toContain("GHSA-x4rx-4gw3-53p4 (CVE-2025-54388)");
      expect(error.message).toContain("upgrade Docker Engine to 28.3.3 or newer");
    }
  });

  test("Docker Engine 27.5.1 fails with exit 3 on the minimum 28.0.0", () => {
    expect(failure(engine("27.5.1"), releaseMinimums()).problems).toEqual([
      "Docker Engine 27.5.1 is older than the required 28.0.0",
    ]);
  });
});

describe("requiredHostTools", () => {
  test("names ss on every host, and systemctl only when docker.systemdUnit is true", () => {
    expect(requiredHostTools(false)).toEqual(["ss"]);
    expect(requiredHostTools(true)).toEqual(["ss", "systemctl"]);
  });
});

describe("compareVersions", () => {
  test("compares numerically and ignores build and distribution suffixes", () => {
    expect(compareVersions("24.0.0", "24.0.0")).toBe(0);
    expect(compareVersions("27.3.1", "24.0.0")).toBeGreaterThan(0);
    expect(compareVersions("9.0.0", "24.0.0")).toBeLessThan(0);
    expect(compareVersions("26.1.5+dfsg1", "26.1.5")).toBe(0);
    expect(compareVersions("28.0.0-rc.1", "27.9.9")).toBeGreaterThan(0);
    expect(compareVersions("24.0", "24.0.0")).toBe(0);
    expect(compareVersions("2.24.1", "2.24.0")).toBeGreaterThan(0);
  });

  test("rejects a value that is not a version", () => {
    expect(() => compareVersions("abc", "1.0.0")).toThrow("'abc' is not a version number");
  });
});

describe("parseSsListeners", () => {
  test("returns the process name of every listening socket, or an empty name when ss shows none", () => {
    const output = [
      'LISTEN 0      4096         0.0.0.0:443       0.0.0.0:*    users:(("docker-proxy",pid=1234,fd=7))',
      'LISTEN 0      4096            [::]:443          [::]:*    users:(("docker-proxy",pid=1240,fd=7))',
      "LISTEN 0      511          0.0.0.0:443       0.0.0.0:*",
      "",
    ].join("\n");
    expect(parseSsListeners(output)).toEqual(["docker-proxy", "docker-proxy", ""]);
  });

  test("an empty output means nothing listens", () => {
    expect(parseSsListeners("")).toEqual([]);
    expect(parseSsListeners("\n")).toEqual([]);
  });
});

describe("publishedPorts", () => {
  test("lists the host ports the rendered compose project publishes", () => {
    expect(publishedPorts(renderCompose(desiredFixture(), TRUST_FIXTURE))).toEqual([443, 18080]);
  });

  test("collects ports across services, once each and in order, and skips services without ports", () => {
    const compose = [
      "services:",
      "  a:",
      "    ports:",
      '      - { target: 443, published: "443" }',
      "      - { target: 80, published: 80 }",
      "  b:",
      "    ports:",
      '      - { target: 8443, published: "443" }',
      "  c:",
      "    image: x",
      "",
    ].join("\n");
    expect(publishedPorts(compose)).toEqual([80, 443]);
  });

  test("a compose file without services publishes nothing", () => {
    expect(publishedPorts("name: libredb\n")).toEqual([]);
  });

  test("rejects a port entry the installer did not render in the long form", () => {
    const compose = ["services:", "  a:", "    ports:", '      - "443:443"', ""].join("\n");
    expect(() => publishedPorts(compose)).toThrow("service a publishes a port without a numeric published field");
  });
});
