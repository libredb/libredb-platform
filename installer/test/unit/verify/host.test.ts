import { describe, expect, test } from "bun:test";
import type { ComposeContainer } from "../../../src/adapters/docker";
import type { PsqlLogin, PsqlResult, SqlRunner } from "../../../src/sql/runner";
import {
  clockScript,
  clockSkewCheck,
  componentsHealthyCheck,
  HOST_CHECKS,
  noProxyCheck,
  type HostCheckContext,
} from "../../../src/verify/host";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const HOSTS = ["platform.example.com", "studio.example.com", "auth.example.com", "postgres", ".svc", ".cluster.local", "localhost", "127.0.0.1"];

const line = (name: string, value: unknown) => `libredb-result ${name} ${JSON.stringify(value)}\n`;
const ok = (stdout: string): PsqlResult => ({ exitCode: 0, stdout, stderr: "" });

class FakeSql implements SqlRunner {
  readonly users: string[] = [];
  readonly #results: PsqlResult[];

  constructor(...results: PsqlResult[]) {
    this.#results = results;
  }

  async run(login: PsqlLogin, _script: string): Promise<PsqlResult> {
    this.users.push(login.user);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("the fake runner has no more results");
    return result;
  }
}

const container = (service: string, health = "healthy", state = "running"): ComposeContainer => ({
  id: `${service}-id`,
  name: `libredb-${service}-1`,
  service,
  state,
  health,
  image: `${service}-image`,
});

const SERVICES = ["edge", "postgres", "keycloak", "platform", "studio"];

function context(overrides: Partial<HostCheckContext> = {}): { host: HostCheckContext } {
  return {
    host: {
      now: () => NOW,
      sql: new FakeSql(ok(line("clock", NOW))),
      admin: { host: "postgres", port: 5432, database: "postgres", user: "postgres", password: "pw" },
      keycloakClock: { what: "the Keycloak clock", read: async () => NOW },
      readFile: () => `NO_PROXY=${HOSTS.join(",")}\nno_proxy=${HOSTS.join(",")}\n`,
      appEnvFiles: ["/opt/libredb/env/platform.env", "/opt/libredb/env/studio.env"],
      noProxyHosts: HOSTS,
      services: SERVICES,
      containers: async () => SERVICES.map((service) => container(service)),
      ...overrides,
    },
  };
}

describe("clock-skew", () => {
  test("a skew of 16 s between the installer clock and PostgreSQL now() fails clock-skew naming both clocks", async () => {
    const sql = new FakeSql(ok(line("clock", NOW + 16_000)));
    expect(await clockSkewCheck.run(context({ sql }))).toEqual({
      passed: false,
      cause:
        "the PostgreSQL clock reads 2026-10-15T12:00:16.000Z and the installer clock 2026-10-15T12:00:00.000Z, " +
        "16.0 s apart, and the limit is 15 s",
    });
    expect(sql.users).toEqual(["postgres"]);
  });

  test("passes within 15 s, and names the Keycloak clock when it is off", async () => {
    expect(await clockSkewCheck.run(context({ sql: new FakeSql(ok(line("clock", NOW - 14_000))) }))).toEqual({ passed: true });
    const slowKeycloak = context({ keycloakClock: { what: "the Keycloak clock", read: async () => NOW - 20_000 } });
    expect(await clockSkewCheck.run(slowKeycloak)).toEqual({
      passed: false,
      cause:
        "the Keycloak clock reads 2026-10-15T11:59:40.000Z and the installer clock 2026-10-15T12:00:00.000Z, " +
        "20.0 s apart, and the limit is 15 s",
    });
    expect(clockScript()).toContain("clock_timestamp()");
  });
});

describe("no-proxy", () => {
  test("an app env whose NO_PROXY misses the auth host fails no-proxy naming the host", async () => {
    const files: Record<string, string> = {
      "/opt/libredb/env/platform.env": `NO_PROXY=${HOSTS.join(",")}\n`,
      "/opt/libredb/env/studio.env": `HTTPS_PROXY=http://proxy:3128\nNO_PROXY='${HOSTS.filter((host) => host !== "auth.example.com").join(",")}'\n`,
    };
    expect(await noProxyCheck.run(context({ readFile: (path) => files[path] ?? "" }))).toEqual({
      passed: false,
      cause: "NO_PROXY of /opt/libredb/env/studio.env misses auth.example.com",
    });
  });

  test("checks no_proxy too, and names an env file without NO_PROXY", async () => {
    const files: Record<string, string> = {
      "/opt/libredb/env/platform.env": `NO_PROXY=${HOSTS.join(",")}\nno_proxy=localhost\n`,
      "/opt/libredb/env/studio.env": "GOVERNANCE_SOURCE=postgres\n",
    };
    const outcome = await noProxyCheck.run(context({ readFile: (path) => files[path] ?? "" }));
    expect(outcome).toEqual({
      passed: false,
      cause:
        "no_proxy of /opt/libredb/env/platform.env misses platform.example.com, studio.example.com, auth.example.com, " +
        "postgres, .svc, .cluster.local, 127.0.0.1; /opt/libredb/env/studio.env sets no NO_PROXY",
    });
    expect(await noProxyCheck.run(context())).toEqual({ passed: true });
  });
});

describe("components-healthy", () => {
  test("an unhealthy keycloak service fails components-healthy naming the service", async () => {
    const containers = async () => SERVICES.map((service) => container(service, service === "keycloak" ? "unhealthy" : "healthy"));
    expect(await componentsHealthyCheck.run(context({ containers }))).toEqual({
      passed: false,
      cause: "keycloak is running and unhealthy",
    });
  });

  test("names a missing service, a stopped one and one without a health status", async () => {
    const containers = async () => [
      container("edge", ""),
      container("postgres", "", "exited"),
      container("platform"),
      container("studio", "starting"),
    ];
    expect(await componentsHealthyCheck.run(context({ containers }))).toEqual({
      passed: false,
      cause:
        "edge is running and reports no health status; postgres is exited and reports no health status; " +
        "keycloak has no container; studio is running and starting",
    });
    expect(await componentsHealthyCheck.run(context())).toEqual({ passed: true });
  });
});

test("the host checks run in the order components, clock, proxy", () => {
  expect(HOST_CHECKS.map((check) => check.id)).toEqual(["components-healthy", "clock-skew", "no-proxy"]);
});
