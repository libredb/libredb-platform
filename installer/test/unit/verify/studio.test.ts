import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateSealKeyPair } from "../../../src/secrets/seal-keys";
import type { PsqlLogin, PsqlResult, SqlRunner } from "../../../src/sql/runner";
import type { ProbeRequest, ProbeResult } from "../../../src/verify/platform";
import {
  activeContract,
  bridgeNotifyRoundtripCheck,
  HEARTBEAT_WAIT_MS,
  instancesScript,
  notifyScript,
  STUDIO_CHECKS,
  studioCanaryCheck,
  studioHeartbeatCheck,
  studioReadyCheck,
  type StudioCheckContext,
  type StudioInstance,
} from "../../../src/verify/studio";

const sealKey = generateSealKeyPair();
const otherKey = generateSealKeyPair();

// The /api/ready body of a Studio in governance mode with contract 1 active, recorded from the pinned Studio image.
const RECORDED_READY_OK = { status: "ok", contract: { supported: [1], active: 1 } };

// Platform's vendored copy of the Studio contract manifest, which publishes the /api/ready body.
const CONTRACT_MANIFEST = join(import.meta.dir, "..", "..", "..", "..", "tests", "fixtures", "governance", "contract-v1.json");

const login = (user: string): PsqlLogin => ({ host: "postgres", port: 5432, database: "libredb", user, password: "pw" });

const line = (name: string, value: unknown) => `libredb-result ${name} ${JSON.stringify(value)}\n`;

const ok = (stdout: string): PsqlResult & ProbeResult => ({ exitCode: 0, stdout, stderr: "" });

class FakeSql implements SqlRunner {
  readonly calls: { user: string; script: string }[] = [];
  readonly #results: PsqlResult[];

  constructor(...results: PsqlResult[]) {
    this.#results = results;
  }

  async run(login: PsqlLogin, script: string): Promise<PsqlResult> {
    this.calls.push({ user: login.user, script });
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

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

function instance(overrides: Partial<StudioInstance> = {}): StudioInstance {
  return {
    instanceId: "libredb-studio",
    studioVersion: "0.19.0",
    supportedContracts: [1],
    keyringKids: [sealKey.kid],
    canary: { [sealKey.kid]: "ok" },
    startedAt: NOW - 600_000,
    lastSeenAt: NOW - 10_000,
    lastNotificationAt: null,
    ...overrides,
  };
}

const instances = (now: number, rows: StudioInstance[]) => ok(line("instances", { now, rows }));

function context(overrides: Partial<StudioCheckContext> = {}): { studio: StudioCheckContext } {
  return {
    studio: {
      probe: new FakeProbe(),
      readyUrl: "http://studio:3000/api/ready",
      sql: new FakeSql(),
      login: login("libredb_studio"),
      platformPublishes: [1],
      studioSupports: [1],
      reportedVersion: "0.19.0",
      platformSealPublicKey: () => sealKey.publicKey,
      heartbeatWaitMs: HEARTBEAT_WAIT_MS,
      canaryWaitMs: 60_000,
      sleep: async () => {},
      ...overrides,
    },
  };
}

describe("studio-ready", () => {
  test("a recorded /api/ready body with status ok and contract.active 1 passes studio-ready, and status ready fails naming the status", async () => {
    const probe = new FakeProbe(ok(line("ready", { status: 200, body: JSON.stringify(RECORDED_READY_OK) })));
    expect(await studioReadyCheck.run(context({ probe }))).toEqual({ passed: true });
    expect(probe.requests[0]?.env).toEqual({ PROBE_URL: "http://studio:3000/api/ready" });

    const off = { status: "ready", contract: { supported: [1], active: null } };
    const offProbe = new FakeProbe(ok(line("ready", { status: 200, body: JSON.stringify(off) })));
    expect(await studioReadyCheck.run(context({ probe: offProbe }))).toEqual({
      passed: false,
      cause:
        "GET http://studio:3000/api/ready answered 200 with status ready, not ok: " +
        "Studio runs without governance, so GOVERNANCE_SOURCE is not postgres",
    });
  });

  test("the recorded /api/ready body matches the shape that the Platform repo's vendored tests/fixtures/governance/contract-v1.json publishes", () => {
    const manifest = JSON.parse(readFileSync(CONTRACT_MANIFEST, "utf8")) as {
      readiness: {
        path: string;
        schema: {
          required: string[];
          properties: {
            status: { enum: string[] };
            contract: { required: string[]; properties: Record<string, unknown> };
          } & Record<string, unknown>;
        };
        examples: unknown[];
      };
    };
    const { readiness } = manifest;
    expect(readiness.path).toBe("/api/ready");
    expect(Object.keys(RECORDED_READY_OK).every((key) => key in readiness.schema.properties)).toBe(true);
    expect(readiness.schema.required.every((key) => key in RECORDED_READY_OK)).toBe(true);
    expect(readiness.schema.properties.status.enum).toContain(RECORDED_READY_OK.status);
    expect(Object.keys(RECORDED_READY_OK.contract).sort()).toEqual(
      Object.keys(readiness.schema.properties.contract.properties).sort(),
    );
    expect(readiness.schema.properties.contract.required.sort()).toEqual(["active", "supported"]);
    expect(readiness.examples).toContainEqual(RECORDED_READY_OK);
  });

  test("a 503 names the status and Studio's detail and points to the Studio log", async () => {
    const body = { status: "misconfigured", contract: { supported: [1], active: null }, detail: "bridge.grants_v1: 42501" };
    const probe = new FakeProbe(ok(line("ready", { status: 503, body: JSON.stringify(body) })));
    expect(await studioReadyCheck.run(context({ probe }))).toEqual({
      passed: false,
      cause:
        "GET http://studio:3000/api/ready answered 503 with status misconfigured, not ok: bridge.grants_v1: 42501; " +
        "the Studio log has the full message: docker compose -p libredb logs studio",
    });
  });

  test("an active contract other than the highest common version fails naming both", async () => {
    const body = { status: "ok", contract: { supported: [1, 2], active: 1 } };
    const probe = new FakeProbe(ok(line("ready", { status: 200, body: JSON.stringify(body) })));
    const outcome = await studioReadyCheck.run(context({ probe, platformPublishes: [1, 2], studioSupports: [1, 2] }));
    expect(outcome).toEqual({
      passed: false,
      cause: "Studio reports contract 1 active, and the highest version common to the release manifest is 2",
    });
  });

  test("fails on a request that could not be sent, a body that is not the readiness JSON, or no common version", async () => {
    const refused = new FakeProbe(ok(line("ready", { error: "Error: getaddrinfo ENOTFOUND studio" })));
    expect(await studioReadyCheck.run(context({ probe: refused }))).toEqual({
      passed: false,
      cause: "GET http://studio:3000/api/ready failed: Error: getaddrinfo ENOTFOUND studio",
    });
    const html = new FakeProbe(ok(line("ready", { status: 502, body: "<html>Bad Gateway</html>" })));
    expect(await studioReadyCheck.run(context({ probe: html }))).toEqual({
      passed: false,
      cause: "GET http://studio:3000/api/ready answered 502 without Studio's readiness JSON: <html>Bad Gateway</html>",
    });
    expect(() => activeContract([1], [2])).toThrow(
      "the release manifest has no contract version common to platformPublishes [1] and studioSupports [2]",
    );
    expect(activeContract([1, 2, 3], [2, 3, 4])).toBe(3);
  });
});

describe("studio-heartbeat", () => {
  test("two live rows, or one live row whose instance_id is not libredb-studio, fail studio-heartbeat naming them", async () => {
    const two = new FakeSql(instances(NOW, [instance(), instance({ instanceId: "studio-7f9c" })]));
    expect(await studioHeartbeatCheck.run(context({ sql: two }))).toEqual({
      passed: false,
      cause:
        "bridge.studio_instances_v1 holds 2 rows seen in the last 2 minutes, libredb-studio and studio-7f9c, " +
        "and v1 runs exactly one, libredb-studio",
    });
    const other = new FakeSql(instances(NOW, [instance({ instanceId: "studio-7f9c" })]));
    expect(await studioHeartbeatCheck.run(context({ sql: other }))).toEqual({
      passed: false,
      cause:
        "bridge.studio_instances_v1 holds 1 row seen in the last 2 minutes, studio-7f9c, " +
        "and v1 runs exactly one, libredb-studio",
    });
    const none = new FakeSql(instances(NOW, []));
    expect(await studioHeartbeatCheck.run(context({ sql: none }))).toEqual({
      passed: false,
      cause:
        "bridge.studio_instances_v1 holds 0 rows seen in the last 2 minutes, none, " +
        "and v1 runs exactly one, libredb-studio",
    });
    expect(two.calls[0]?.user).toBe("libredb_studio");
  });

  test("passes once last_seen_at passes the start of the check, which the next beat proves", async () => {
    const sleeps: number[] = [];
    const sql = new FakeSql(
      instances(NOW, [instance({ lastSeenAt: NOW - 20_000 })]),
      instances(NOW + 2_000, [instance({ lastSeenAt: NOW - 20_000 })]),
      instances(NOW + 4_000, [instance({ lastSeenAt: NOW + 3_000 })]),
    );
    const outcome = await studioHeartbeatCheck.run(context({ sql, sleep: async (ms) => void sleeps.push(ms) }));
    expect(outcome).toEqual({ passed: true });
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  test("fails when last_seen_at does not advance within the wait", async () => {
    const stale = () => instances(NOW, [instance({ lastSeenAt: NOW - 20_000 })]);
    const sql = new FakeSql(stale(), stale(), stale());
    expect(await studioHeartbeatCheck.run(context({ sql, heartbeatWaitMs: 4_000 }))).toEqual({
      passed: false,
      cause:
        "libredb-studio last beat at 2026-10-15T11:59:40.000Z and sent no beat within 4 s of " +
        "2026-10-15T12:00:00.000Z, so its upsert does not advance last_seen_at",
    });
  });

  test("waits through a missed beat for the one after it, which a loaded host delays past one interval", async () => {
    // The last beat came 1 s before the start, the next one failed, and the one after it lands 61 s after the start.
    // The check reads every 2 s, so its 32nd read is the first after that beat.
    const before = Array.from({ length: 31 }, () => instances(NOW, [instance({ lastSeenAt: NOW - 1_000 })]));
    const sql = new FakeSql(...before, instances(NOW + 62_000, [instance({ lastSeenAt: NOW + 61_000 })]));
    expect(await studioHeartbeatCheck.run(context({ sql }))).toEqual({ passed: true });
  });

  test("gives up after 75 s, two and a half heartbeat intervals, and names that wait", async () => {
    const stale = Array.from({ length: 50 }, () => instances(NOW, [instance({ lastSeenAt: NOW - 20_000 })]));
    expect(await studioHeartbeatCheck.run(context({ sql: new FakeSql(...stale) }))).toEqual({
      passed: false,
      cause:
        "libredb-studio last beat at 2026-10-15T11:59:40.000Z and sent no beat within 75 s of " +
        "2026-10-15T12:00:00.000Z, so its upsert does not advance last_seen_at",
    });
  });

  test("the instances query reads the live rows of bridge.studio_instances_v1 and the database clock", () => {
    const script = instancesScript();
    expect(script).toContain("FROM bridge.studio_instances_v1");
    expect(script).toContain("last_seen_at > now() - interval '2 minutes'");
  });
});

describe("studio-canary", () => {
  test("an instance reporting canary UNKNOWN_KID for the Platform kid fails studio-canary naming the instance", async () => {
    const rows = () => instances(NOW, [instance({ canary: { [sealKey.kid]: "UNKNOWN_KID" } })]);
    const sql = new FakeSql(rows(), rows(), rows());
    expect(await studioCanaryCheck.run(context({ sql, canaryWaitMs: 4_000 }))).toEqual({
      passed: false,
      cause: `within 4 s: libredb-studio reports canary UNKNOWN_KID for the Platform kid ${sealKey.kid}`,
    });
  });

  test("names a missing kid, a missing canary, another Studio version and other contract versions", async () => {
    const wrong = instance({
      keyringKids: [otherKey.kid],
      canary: {},
      studioVersion: "0.18.3",
      supportedContracts: [1, 2],
    });
    const sql = new FakeSql(instances(NOW, [wrong]));
    expect(await studioCanaryCheck.run(context({ sql, canaryWaitMs: 0 }))).toEqual({
      passed: false,
      cause:
        `within 0 s: libredb-studio lists no Platform kid ${sealKey.kid} in keyring_kids [${otherKey.kid}]; ` +
        `libredb-studio reports no canary for the Platform kid ${sealKey.kid}; ` +
        "libredb-studio reports Studio 0.18.3, and the release manifest's studio.reportedVersion is 0.19.0; " +
        "libredb-studio supports contracts [1, 2], and the release manifest's studioSupports is [1]",
    });
  });

  test("reads the Platform kid from the key Platform runs with, and waits for a canary that is not ok yet", async () => {
    const sleeps: number[] = [];
    const sql = new FakeSql(
      instances(NOW, [instance({ keyringKids: [otherKey.kid], canary: {} })]),
      instances(NOW, [instance({ keyringKids: [otherKey.kid], canary: { [otherKey.kid]: "ok" } })]),
    );
    const outcome = await studioCanaryCheck.run(
      context({ sql, platformSealPublicKey: () => otherKey.publicKey, sleep: async (ms) => void sleeps.push(ms) }),
    );
    expect(outcome).toEqual({ passed: true });
    expect(sleeps).toEqual([2_000]);
  });

  test("compares the version each instance reports with the version the pinned build reports, also for a git:<sha> pin", async () => {
    // A Studio built from a git commit reports the version of its package.json, which studio.reportedVersion records.
    const older = new FakeSql(instances(NOW, [instance({ studioVersion: "0.18.2" })]));
    expect(await studioCanaryCheck.run(context({ sql: older, reportedVersion: "0.18.3", canaryWaitMs: 0 }))).toEqual({
      passed: false,
      cause: "within 0 s: libredb-studio reports Studio 0.18.2, and the release manifest's studio.reportedVersion is 0.18.3",
    });
    const pinned = new FakeSql(instances(NOW, [instance({ studioVersion: "0.18.3" })]));
    expect(await studioCanaryCheck.run(context({ sql: pinned, reportedVersion: "0.18.3" }))).toEqual({ passed: true });
  });

  test("no live instance fails naming the view", async () => {
    const sql = new FakeSql(instances(NOW, []));
    expect(await studioCanaryCheck.run(context({ sql, canaryWaitMs: 0 }))).toEqual({
      passed: false,
      cause: "within 0 s: bridge.studio_instances_v1 holds no row seen in the last 2 minutes",
    });
  });
});

describe("bridge-notify-roundtrip", () => {
  test("an instance whose last_notification_at stays before the send time fails bridge-notify-roundtrip naming the instance", async () => {
    const sent = NOW;
    const rows = () => instances(NOW, [instance({ lastNotificationAt: NOW - 60_000 })]);
    const sql = new FakeSql(ok(line("sent", sent)), rows(), rows(), rows());
    expect(await bridgeNotifyRoundtripCheck.run(context({ sql, heartbeatWaitMs: 4_000 }))).toEqual({
      passed: false,
      cause:
        "after NOTIFY libredb_bridge at 2026-10-15T12:00:00.000Z, libredb-studio reported no newer " +
        "last_notification_at within 4 s (last 2026-10-15T11:59:00.000Z)",
    });
    expect(sql.calls.map((call) => call.user)).toEqual(["libredb_studio", "libredb_studio", "libredb_studio", "libredb_studio"]);
    expect(sql.calls[0]?.script).toBe(notifyScript());
  });

  test("passes once every live instance reports a notification after the send", async () => {
    const sql = new FakeSql(
      ok(line("sent", NOW)),
      instances(NOW, [instance({ lastNotificationAt: null })]),
      instances(NOW, [instance({ lastNotificationAt: NOW + 120 })]),
    );
    expect(await bridgeNotifyRoundtripCheck.run(context({ sql }))).toEqual({ passed: true });
  });

  test("waits through a missed beat for the one that reports the notification", async () => {
    // Studio writes last_notification_at only with a beat: the one after the send failed, and the next one reports the
    // notification. The check reads every 2 s, so its 32nd read, 62 s after the send, is the first after that beat.
    const before = Array.from({ length: 31 }, () => instances(NOW, [instance({ lastNotificationAt: NOW - 60_000 })]));
    const sql = new FakeSql(ok(line("sent", NOW)), ...before, instances(NOW, [instance({ lastNotificationAt: NOW + 30 })]));
    expect(await bridgeNotifyRoundtripCheck.run(context({ sql }))).toEqual({ passed: true });
  });

  test("gives up after 75 s, two and a half heartbeat intervals, and names that wait", async () => {
    const stale = Array.from({ length: 50 }, () => instances(NOW, [instance({ lastNotificationAt: NOW - 60_000 })]));
    expect(await bridgeNotifyRoundtripCheck.run(context({ sql: new FakeSql(ok(line("sent", NOW)), ...stale) }))).toEqual({
      passed: false,
      cause:
        "after NOTIFY libredb_bridge at 2026-10-15T12:00:00.000Z, libredb-studio reported no newer " +
        "last_notification_at within 75 s (last 2026-10-15T11:59:00.000Z)",
    });
  });

  test("passes when Studio stamps the delivery with the send's own millisecond, because its clock has no finer resolution", async () => {
    // PostgreSQL's now() carries microseconds, and Studio's Date.now() floors the delivery to the millisecond, so a
    // delivery within the millisecond of the send reads as that millisecond.
    const sql = new FakeSql(ok(line("sent", NOW + 120.456)), instances(NOW, [instance({ lastNotificationAt: NOW + 120 })]));
    expect(await bridgeNotifyRoundtripCheck.run(context({ sql, heartbeatWaitMs: 0 }))).toEqual({ passed: true });
    const before = new FakeSql(ok(line("sent", NOW + 120.456)), instances(NOW, [instance({ lastNotificationAt: NOW + 119 })]));
    expect((await bridgeNotifyRoundtripCheck.run(context({ sql: before, heartbeatWaitMs: 0 }))).passed).toBe(false);
  });

  test("names an instance that never received one, and fails without a live instance", async () => {
    const sql = new FakeSql(ok(line("sent", NOW)), instances(NOW, [instance()]));
    expect(await bridgeNotifyRoundtripCheck.run(context({ sql, heartbeatWaitMs: 0 }))).toEqual({
      passed: false,
      cause:
        "after NOTIFY libredb_bridge at 2026-10-15T12:00:00.000Z, libredb-studio reported no newer " +
        "last_notification_at within 0 s (last never)",
    });
    const empty = new FakeSql(ok(line("sent", NOW)), instances(NOW, []));
    expect(await bridgeNotifyRoundtripCheck.run(context({ sql: empty, heartbeatWaitMs: 0 }))).toEqual({
      passed: false,
      cause: "bridge.studio_instances_v1 holds no row seen in the last 2 minutes, so no instance can receive a notification",
    });
  });

  test("the script sends the change hint of kind settings on channel libredb_bridge after reading the clock", () => {
    const script = notifyScript();
    expect(script).toContain(`NOTIFY libredb_bridge, '{"v":1,"kind":"settings"}';`);
    expect(script.indexOf("now()")).toBeLessThan(script.indexOf("NOTIFY"));
  });
});

test("the Studio checks run in the order ready, heartbeat, canary, notification", () => {
  expect(STUDIO_CHECKS.map((check) => check.id)).toEqual([
    "studio-ready",
    "studio-heartbeat",
    "studio-canary",
    "bridge-notify-roundtrip",
  ]);
});
