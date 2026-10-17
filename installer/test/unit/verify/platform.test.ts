import { describe, expect, test } from "bun:test";
import { generateSealKeyPair } from "../../../src/secrets/seal-keys";
import type { PsqlLogin, PsqlResult, SqlRunner } from "../../../src/sql/runner";
import { CATALOGUE } from "../../../src/verify/catalogue";
import {
  BRIDGE_PRIVILEGE_ROWS,
  bridgeContractCheck,
  bridgePrivilegesCheck,
  PLATFORM_CHECKS,
  platformAdminApiCheck,
  platformReadyCheck,
  platformSigninRedirectCheck,
  sealCanaryPublishedCheck,
  type PlatformCheckContext,
  type ProbeRequest,
  type ProbeResult,
} from "../../../src/verify/platform";

const PLATFORM_URL = "https://platform.example.com";
const ISSUER = "https://auth.example.com/realms/libredb";
const CALLBACK = `${PLATFORM_URL}/api/auth/callback/keycloak`;
const sealKey = generateSealKeyPair();

const login = (user: string): PsqlLogin => ({ host: "postgres", port: 5432, database: "libredb", user, password: "pw" });

const line = (name: string, value: unknown) => `libredb-result ${name} ${JSON.stringify(value)}\n`;

/** A runner that answers each script with the next canned result and records who ran what. */
class FakeSql implements SqlRunner {
  readonly calls: { user: string; database: string; script: string }[] = [];
  readonly #results: PsqlResult[];

  constructor(...results: PsqlResult[]) {
    this.#results = results;
  }

  async run(login: PsqlLogin, script: string): Promise<PsqlResult> {
    this.calls.push({ user: login.user, database: login.database, script });
    const result = this.#results.shift();
    if (result === undefined) throw new Error("the fake runner has no more results");
    return result;
  }
}

class FakeProbe {
  readonly requests: ProbeRequest[] = [];
  readonly #results: ProbeResult[];

  constructor(...results: ProbeResult[]) {
    this.#results = results;
  }

  async run(request: ProbeRequest): Promise<ProbeResult> {
    this.requests.push(request);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("the fake probe has no more results");
    return result;
  }
}

const ok = (stdout: string): PsqlResult & ProbeResult => ({ exitCode: 0, stdout, stderr: "" });

function context(overrides: Partial<PlatformCheckContext> = {}): { platform: PlatformCheckContext } {
  return {
    platform: {
      probe: new FakeProbe(),
      sql: new FakeSql(),
      admin: login("postgres"),
      studio: login("libredb_studio"),
      platformUrl: PLATFORM_URL,
      readyUrl: "http://platform:3000/api/health/ready",
      issuer: ISSUER,
      platformEnvFile: "/opt/libredb/env/platform.env",
      platformPublishes: [1],
      sealPublicKey: sealKey.publicKey,
      canaryWaitMs: 30_000,
      sleep: async () => {},
      ...overrides,
    },
  };
}

const convergedPrivileges = () => ({
  owners: { platform: "libredb_owner", bridge: "libredb_owner", studio: "libredb_studio" },
  privileges: Object.fromEntries(BRIDGE_PRIVILEGE_ROWS.map((row) => [row.id, row.held])),
});

describe("bridge-privileges", () => {
  test("bridge-privileges names every failed row, such as USAGE on schema platform for libredb_studio", async () => {
    const facts = convergedPrivileges();
    facts.privileges["libredb_studio:USAGE:platform"] = true;
    facts.privileges["libredb_platform:DELETE:bridge.query_event"] = true;
    facts.privileges["libredb_studio:INSERT:bridge.query_events_v1"] = false;
    const sql = new FakeSql(ok(line("bridge-privileges", facts)));

    const outcome = await bridgePrivilegesCheck.run(context({ sql }));
    expect(outcome).toEqual({
      passed: false,
      cause:
        "false rows: libredb_studio has no USAGE on schema platform; " +
        "libredb_studio has INSERT on bridge.query_events_v1; " +
        "libredb_platform has no DELETE on bridge.query_event",
    });
    // The admin role reads every role's privileges in database libredb.
    expect(sql.calls.map((call) => [call.user, call.database])).toEqual([["postgres", "libredb"]]);
  });

  test("passes on the post-migration schema owners and privilege rows, which the query asks with has_schema_privilege and has_table_privilege", async () => {
    const sql = new FakeSql(ok(line("bridge-privileges", convergedPrivileges())));
    expect(await bridgePrivilegesCheck.run(context({ sql }))).toEqual({ passed: true });
    const script = sql.calls[0]?.script ?? "";
    expect(script).toContain("has_schema_privilege");
    expect(script).toContain("has_table_privilege");
    expect(BRIDGE_PRIVILEGE_ROWS.map((row) => row.row)).toEqual([
      "libredb_studio has no USAGE on schema platform",
      "libredb_studio has no SELECT on bridge.query_event",
      "libredb_studio has no SELECT on bridge.query_events_v1",
      "libredb_studio has INSERT on bridge.query_events_v1",
      "libredb_platform has no UPDATE on bridge.query_event",
      "libredb_platform has no DELETE on bridge.query_event",
      "libredb_platform has no TRUNCATE on bridge.query_event",
    ]);
  });

  test("a schema with another owner, and a role or object that does not exist, are false rows", async () => {
    const facts = convergedPrivileges();
    facts.owners.bridge = "postgres";
    delete (facts.owners as Partial<typeof facts.owners>).studio;
    facts.privileges["libredb_studio:SELECT:bridge.query_event"] = null as unknown as boolean;
    const sql = new FakeSql(ok(line("bridge-privileges", facts)));
    expect(await bridgePrivilegesCheck.run(context({ sql }))).toEqual({
      passed: false,
      cause:
        "false rows: schema bridge is owned by libredb_owner; schema studio is owned by libredb_studio; " +
        "libredb_studio has no SELECT on bridge.query_event",
    });
  });

  test("a failed psql run fails the check with psql's error", async () => {
    const sql = new FakeSql({ exitCode: 2, stdout: "", stderr: "psql: error: connection refused\n" });
    expect(bridgePrivilegesCheck.run(context({ sql }))).rejects.toThrow("connection refused");
  });
});

describe("bridge-contract", () => {
  test("passes when the versions listed as current or deprecated equal the manifest's platformPublishes, read as libredb_studio", async () => {
    const sql = new FakeSql(
      ok(
        line("contract", [
          { version: 1, status: "current" },
          { version: 2, status: "retired" },
        ]),
      ),
    );
    expect(await bridgeContractCheck.run(context({ sql }))).toEqual({ passed: true });
    expect(sql.calls.map((call) => [call.user, call.database])).toEqual([["libredb_studio", "libredb"]]);
    expect(sql.calls[0]?.script).toContain("FROM bridge.contract");
  });

  test("fails naming both version sets", async () => {
    const sql = new FakeSql(ok(line("contract", [{ version: 2, status: "deprecated" }])));
    expect(await bridgeContractCheck.run(context({ sql, platformPublishes: [1, 2] }))).toEqual({
      passed: false,
      cause: "bridge.contract lists [2] as current or deprecated, and the release manifest publishes [1, 2]",
    });
    const empty = new FakeSql(ok(line("contract", [])));
    expect(await bridgeContractCheck.run(context({ sql: empty }))).toEqual({
      passed: false,
      cause: "bridge.contract lists [] as current or deprecated, and the release manifest publishes [1]",
    });
  });
});

describe("seal-canary-published", () => {
  test("passes when bridge.seal_canary_v1 holds the kid of BRIDGE_SEAL_PUBLIC_KEY, read as libredb_studio", async () => {
    const sql = new FakeSql(ok(line("canaries", ["0000000000000000", sealKey.kid])));
    expect(await sealCanaryPublishedCheck.run(context({ sql }))).toEqual({ passed: true });
    expect(sql.calls.map((call) => call.user)).toEqual(["libredb_studio"]);
  });

  test("waits for a Platform that has not published its canary yet", async () => {
    const sleeps: number[] = [];
    const sql = new FakeSql(ok(line("canaries", [])), ok(line("canaries", [sealKey.kid])));
    const outcome = await sealCanaryPublishedCheck.run(
      context({ sql, sleep: async (ms) => void sleeps.push(ms), canaryWaitMs: 4_000 }),
    );
    expect(outcome).toEqual({ passed: true });
    expect(sleeps).toEqual([2_000]);
  });

  test("fails after the wait naming the kid and the kids it found", async () => {
    const results = Array.from({ length: 3 }, () => ok(line("canaries", ["0000000000000000"])));
    const sql = new FakeSql(...results);
    expect(await sealCanaryPublishedCheck.run(context({ sql, canaryWaitMs: 4_000 }))).toEqual({
      passed: false,
      cause: `bridge.seal_canary_v1 holds no canary for kid ${sealKey.kid} of BRIDGE_SEAL_PUBLIC_KEY within 4 s, only for [0000000000000000]`,
    });
    expect(sql.calls).toHaveLength(3);
  });
});

describe("platform-ready", () => {
  test("passes on 200 with status ready, asked from inside the network", async () => {
    const probe = new FakeProbe(ok(line("ready", { status: 200, body: '{"status":"ready","contract":1}' })));
    expect(await platformReadyCheck.run(context({ probe }))).toEqual({ passed: true });
    expect(probe.requests[0]?.env).toEqual({ PROBE_URL: "http://platform:3000/api/health/ready" });
    expect(probe.requests[0]?.envFile).toBeUndefined();
  });

  test("fails naming the status and the body", async () => {
    const body = '{"status":"not-ready","reason":"contract-missing"}';
    const probe = new FakeProbe(ok(line("ready", { status: 503, body })));
    expect(await platformReadyCheck.run(context({ probe }))).toEqual({
      passed: false,
      cause: `GET http://platform:3000/api/health/ready answered 503: ${body}`,
    });
  });

  test("fails naming a request that could not be sent, or a probe that printed no result", async () => {
    const refused = new FakeProbe(ok(line("ready", { error: "Error: connect ECONNREFUSED 172.18.0.5:3000" })));
    expect(await platformReadyCheck.run(context({ probe: refused }))).toEqual({
      passed: false,
      cause: "GET http://platform:3000/api/health/ready failed: Error: connect ECONNREFUSED 172.18.0.5:3000",
    });
    const broken = new FakeProbe({ exitCode: 125, stdout: "", stderr: "docker: Error response from daemon\n" });
    expect(platformReadyCheck.run(context({ probe: broken }))).rejects.toThrow(
      "the probe container exited with code 125 and printed no ready result: docker: Error response from daemon",
    );
  });
});

describe("platform-signin-redirect", () => {
  const authorize = (params: Record<string, string>) =>
    `${ISSUER}/protocol/openid-connect/auth?${new URLSearchParams(params).toString()}`;

  test("passes on 302 to the issuer's authorization endpoint with Platform's callback as redirect_uri", async () => {
    const location = authorize({ client_id: "libredb-platform", redirect_uri: CALLBACK, response_type: "code" });
    const probe = new FakeProbe(ok(line("signin", { csrfStatus: 200, status: 302, location })));
    expect(await platformSigninRedirectCheck.run(context({ probe }))).toEqual({ passed: true });
    expect(probe.requests[0]?.env).toEqual({ PROBE_PLATFORM_URL: PLATFORM_URL });
    expect(probe.requests[0]?.script).toContain("/api/auth/signin/keycloak");
  });

  test("fails naming where Platform sent the browser instead", async () => {
    const probe = new FakeProbe(
      ok(line("signin", { csrfStatus: 200, status: 302, location: `${PLATFORM_URL}/login?error=Configuration` })),
    );
    expect(await platformSigninRedirectCheck.run(context({ probe }))).toEqual({
      passed: false,
      cause: `the sign-in for provider keycloak redirected to ${PLATFORM_URL}/login?error=Configuration, not to ${ISSUER}/protocol/openid-connect/auth`,
    });
  });

  test("fails on another status, a wrong redirect_uri or client, or a request that could not be sent", async () => {
    const run = async (result: unknown) =>
      platformSigninRedirectCheck.run(context({ probe: new FakeProbe(ok(line("signin", result))) }));
    expect(await run({ csrfStatus: 500, status: 0, location: null })).toEqual({
      passed: false,
      cause: "GET /api/auth/csrf answered 500",
    });
    expect(await run({ csrfStatus: 200, status: 200, location: null })).toEqual({
      passed: false,
      cause: "the sign-in for provider keycloak answered 200, not 302",
    });
    expect(await run({ csrfStatus: 200, status: 302, location: null })).toEqual({
      passed: false,
      cause: "the sign-in for provider keycloak answered 302 without a Location",
    });
    const elsewhere = authorize({ client_id: "libredb-platform", redirect_uri: "https://other.example.com/cb" });
    expect(await run({ csrfStatus: 200, status: 302, location: elsewhere })).toEqual({
      passed: false,
      cause: `the sign-in for provider keycloak sends redirect_uri https://other.example.com/cb, and Platform's callback is ${CALLBACK}`,
    });
    const otherClient = authorize({ client_id: "libredb-studio", redirect_uri: CALLBACK });
    expect(await run({ csrfStatus: 200, status: 302, location: otherClient })).toEqual({
      passed: false,
      cause: "the sign-in for provider keycloak sends client_id libredb-studio, not libredb-platform",
    });
    expect(await run({ error: "Error: getaddrinfo ENOTFOUND platform.example.com" })).toEqual({
      passed: false,
      cause: "the sign-in for provider keycloak failed: Error: getaddrinfo ENOTFOUND platform.example.com",
    });
  });
});

describe("platform-admin-api", () => {
  const converged = {
    base: "http://keycloak:8080",
    realm: "libredb",
    token: 200,
    clients: 200,
    roleHolder: true,
    roleUsers: 200,
    create: 403,
  };
  const admin = "http://keycloak:8080/admin/realms/libredb";

  test("passes when the libredb-platform token reads the admin role's users and is refused a user create, run with the Platform env", async () => {
    const probe = new FakeProbe(ok(line("admin-api", converged)));
    expect(await platformAdminApiCheck.run(context({ probe }))).toEqual({ passed: true });
    expect(probe.requests[0]?.envFile).toBe("/opt/libredb/env/platform.env");
    expect(probe.requests[0]?.script).toContain("/protocol/openid-connect/token");
  });

  test("fails naming the request Keycloak answered otherwise", async () => {
    const run = async (result: unknown) =>
      platformAdminApiCheck.run(context({ probe: new FakeProbe(ok(line("admin-api", result))) }));
    expect(await run({ ...converged, token: 401, clients: undefined })).toEqual({
      passed: false,
      cause: "the libredb-platform client-credentials token from http://keycloak:8080/realms/libredb answered 401, expected 200",
    });
    expect(await run({ ...converged, clients: 403 })).toEqual({
      passed: false,
      cause: `GET ${admin}/clients?clientId=libredb answered 403, expected 200`,
    });
    expect(await run({ ...converged, roleHolder: false })).toEqual({
      passed: false,
      cause: "realm libredb has no client libredb, which holds the roles admin and user",
    });
    expect(await run({ ...converged, roleUsers: 403 })).toEqual({
      passed: false,
      cause: `GET ${admin}/clients/<libredb>/roles/admin/users answered 403, expected 200`,
    });
    expect(await run({ ...converged, create: 400 })).toEqual({
      passed: false,
      cause: `POST ${admin}/users answered 400, expected 403: the libredb-platform service account may manage users`,
    });
    expect(await run({ error: "TypeError: fetch failed" })).toEqual({
      passed: false,
      cause: "the Admin API probe failed: TypeError: fetch failed",
    });
  });
});

describe("the Platform checks in the catalogue", () => {
  test("verify runs the six Platform checks after postgres-privileges, the host checks and edge-tls, then platform-license and Studio's", () => {
    expect(PLATFORM_CHECKS.map((check) => check.id)).toEqual([
      "platform-ready",
      "platform-signin-redirect",
      "platform-admin-api",
      "bridge-contract",
      "seal-canary-published",
      "bridge-privileges",
    ]);
    expect(CATALOGUE.map((check) => check.id)).toEqual([
      "postgres-privileges",
      "components-healthy",
      "clock-skew",
      "no-proxy",
      "edge-tls",
      ...PLATFORM_CHECKS.map((check) => check.id),
      "platform-license",
      "studio-ready",
      "studio-heartbeat",
      "studio-canary",
      "bridge-notify-roundtrip",
      "studio-oidc-chain",
      "oidc-discovery-in-network",
      "admin-mfa",
    ]);
  });
});
