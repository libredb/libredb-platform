// The Studio checks of `verify`, against the contract of Studio's GOVERNANCE.md: readiness with the negotiated
// contract, the heartbeat of the one Studio instance v1 runs, the seal canary for the key Platform runs with, and a
// change notification on channel libredb_bridge that every live instance receives.
// The SQL runs as libredb_studio, which reads the heartbeats through bridge.studio_instances_v1 as a control plane
// would, and the readiness probe runs in a one-shot container on the app network.
import { z } from "zod";
import { STUDIO_HOSTNAME, STUDIO_SERVICE, COMPOSE_PROJECT } from "../render/compose";
import { sealKeyId } from "../secrets/seal-keys";
import { parseResult, parseResults, resultQuery, runScript, type PsqlLogin, type SqlRunner } from "../sql/runner";
import type { Check } from "./catalogue";
import {
  failed,
  PASSED,
  POLL_MS,
  probe,
  READY_SCRIPT,
  readyResult,
  versionList,
  type ProbeRunner,
} from "./platform";

export interface StudioCheckContext {
  /** Runs probe scripts on the network Studio is on. */
  probe: ProbeRunner;
  /** Studio's readiness route as the network reaches it, such as http://studio:3000/api/ready. */
  readyUrl: string;
  sql: SqlRunner;
  /** libredb_studio on database libredb. */
  login: PsqlLogin;
  /** The release manifest's `platformPublishes`. */
  platformPublishes: readonly number[];
  /** The release manifest's `studioSupports`. */
  studioSupports: readonly number[];
  /**
   * The version the pinned Studio build reports in its heartbeat, the release manifest's studio.reportedVersion, such
   * as 0.19.0 for that release, or the package version that a build of a git:<sha> pin reports.
   */
  reportedVersion: string;
  /** BRIDGE_SEAL_PUBLIC_KEY as Platform runs with it, read when the check runs. */
  platformSealPublicKey: () => string;
  /** How long studio-heartbeat and bridge-notify-roundtrip wait for a beat newer than their start, HEARTBEAT_WAIT_MS. */
  heartbeatWaitMs: number;
  /** How long studio-canary waits for every instance to report the canary ok. */
  canaryWaitMs: number;
  sleep: (ms: number) => Promise<void>;
}

type StudioChecks = { studio: StudioCheckContext };

/** How often a Studio instance beats: it upserts its row of bridge.studio_instance every 30 s. */
export const STUDIO_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long studio-heartbeat and bridge-notify-roundtrip wait for a beat newer than their start, the only thing that
 * moves last_seen_at and last_notification_at: two and a half intervals, so when a loaded host delays a beat or a beat
 * fails, the one after it still arrives in time.
 */
export const HEARTBEAT_WAIT_MS = 2.5 * STUDIO_HEARTBEAT_INTERVAL_MS;

/** Where an operator reads the full message behind Studio's short readiness detail or login error. */
export const STUDIO_LOG_HINT = `the Studio log has the full message: docker compose -p ${COMPOSE_PROJECT} logs ${STUDIO_SERVICE}`;

/** The highest contract version common to what Platform publishes and Studio supports. */
export function activeContract(platformPublishes: readonly number[], studioSupports: readonly number[]): number {
  const common = platformPublishes.filter((version) => studioSupports.includes(version));
  if (common.length === 0) {
    throw new Error(
      `the release manifest has no contract version common to platformPublishes ${versionList(platformPublishes)} ` +
        `and studioSupports ${versionList(studioSupports)}`,
    );
  }
  return Math.max(...common);
}

// The two fields of Studio's /api/ready body that the check reads; every other field is ignored.
const readyBody = z.object({
  status: z.string(),
  contract: z.object({ active: z.number().int().nullable() }),
  detail: z.string().optional(),
});

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * studio-ready: GET /api/ready answers 200 with status ok and the highest contract version common to the manifest's
 * platformPublishes and studioSupports active. Studio's detail, which names only its own words, goes into
 * the cause with a pointer to the Studio log.
 */
export const studioReadyCheck: Check<StudioChecks> = {
  id: "studio-ready",
  async run({ studio }) {
    const url = studio.readyUrl;
    const result = await probe(studio, "ready", { script: READY_SCRIPT, env: { PROBE_URL: url } }, readyResult);
    if (result.error !== undefined) return failed(`GET ${url} failed: ${result.error}`);
    const body = readyBody.safeParse(readJson(result.body ?? ""));
    if (!body.success) {
      return failed(`GET ${url} answered ${result.status} without Studio's readiness JSON: ${result.body}`);
    }
    const { status, contract, detail } = body.data;
    if (result.status !== 200 || status !== "ok") {
      const reason =
        status === "ready"
          ? "Studio runs without governance, so GOVERNANCE_SOURCE is not postgres"
          : `${detail ?? "Studio gave no detail"}; ${STUDIO_LOG_HINT}`;
      return failed(`GET ${url} answered ${result.status} with status ${status}, not ok: ${reason}`);
    }
    const expected = activeContract(studio.platformPublishes, studio.studioSupports);
    if (contract.active !== expected) {
      return failed(
        `Studio reports contract ${contract.active} active, and the highest version common to the release manifest is ${expected}`,
      );
    }
    return PASSED;
  },
};

/** One row of bridge.studio_instances_v1 that was seen in the last 2 minutes, with its times in epoch milliseconds. */
export interface StudioInstance {
  instanceId: string;
  studioVersion: string;
  supportedContracts: number[];
  keyringKids: string[];
  canary: Record<string, string>;
  startedAt: number;
  lastSeenAt: number;
  lastNotificationAt: number | null;
}

const epochMs = (column: string) => `(extract(epoch FROM i.${column}) * 1000)::float8`;

/** The database clock and every row of bridge.studio_instances_v1 seen in the last 2 minutes. */
export function instancesScript(): string {
  return `${resultQuery(
    "instances",
    `jsonb_build_object(
  'now', (extract(epoch FROM now()) * 1000)::float8,
  'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'instanceId', i.instance_id,
      'studioVersion', i.studio_version,
      'supportedContracts', to_jsonb(i.supported_contracts),
      'keyringKids', to_jsonb(i.keyring_kids),
      'canary', i.canary,
      'startedAt', ${epochMs("started_at")},
      'lastSeenAt', ${epochMs("last_seen_at")},
      'lastNotificationAt', ${epochMs("last_notification_at")}
    ) ORDER BY i.instance_id), '[]')
    FROM bridge.studio_instances_v1 i WHERE i.last_seen_at > now() - interval '2 minutes'))`,
  )}\n`;
}

const instancesResult = z
  .object({
    now: z.number(),
    rows: z.array(
      z
        .object({
          instanceId: z.string(),
          studioVersion: z.string(),
          supportedContracts: z.array(z.number().int()),
          keyringKids: z.array(z.string()),
          canary: z.record(z.string(), z.string()),
          startedAt: z.number(),
          lastSeenAt: z.number(),
          lastNotificationAt: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

async function liveInstances(studio: StudioCheckContext): Promise<{ now: number; rows: StudioInstance[] }> {
  const result = await runScript(studio.sql, studio.login, instancesScript());
  return parseResult(instancesResult, parseResults(result.stdout).get("instances"), "Studio instance rows");
}

const iso = (ms: number) => new Date(ms).toISOString();
const seconds = (ms: number) => `${ms / 1000} s`;

/**
 * Asks `attempt` again every POLL_MS until it returns no problem or `waitMs` passed, and returns the last problem, or
 * undefined once it found none.
 */
async function poll(
  studio: StudioCheckContext,
  waitMs: number,
  attempt: () => Promise<string | undefined>,
): Promise<string | undefined> {
  for (let waited = 0; ; waited += POLL_MS) {
    const problem = await attempt();
    if (problem === undefined || waited >= waitMs) return problem;
    await studio.sleep(POLL_MS);
  }
}

const NO_LIVE_ROW = "bridge.studio_instances_v1 holds no row seen in the last 2 minutes";

/**
 * studio-heartbeat: exactly one row of bridge.studio_instances_v1 was seen in the last 2 minutes, its instance_id is
 * libredb-studio, and its last_seen_at passes the database time at the start of the check within heartbeatWaitMs,
 * which proves that Studio's heartbeat upsert advances it.
 */
export const studioHeartbeatCheck: Check<StudioChecks> = {
  id: "studio-heartbeat",
  async run({ studio }) {
    const first = await liveInstances(studio);
    const ids = first.rows.map((row) => row.instanceId);
    if (ids.length !== 1 || ids[0] !== STUDIO_HOSTNAME) {
      return failed(
        `bridge.studio_instances_v1 holds ${ids.length} row${ids.length === 1 ? "" : "s"} seen in the last 2 minutes, ` +
          `${ids.length === 0 ? "none" : ids.join(" and ")}, and v1 runs exactly one, ${STUDIO_HOSTNAME}`,
      );
    }
    const start = first.now;
    let lastSeenAt = (first.rows[0] as StudioInstance).lastSeenAt;
    let fresh = lastSeenAt > start;
    let attempts = 0;
    const problem = await poll(studio, studio.heartbeatWaitMs, async () => {
      // The first attempt judges the rows read above; each later one reads them again.
      if (attempts++ > 0 && !fresh) {
        const row = (await liveInstances(studio)).rows.find((candidate) => candidate.instanceId === STUDIO_HOSTNAME);
        lastSeenAt = row?.lastSeenAt ?? lastSeenAt;
        fresh = lastSeenAt > start;
      }
      return fresh ? undefined : "stale";
    });
    if (problem === undefined) return PASSED;
    return failed(
      `${STUDIO_HOSTNAME} last beat at ${iso(lastSeenAt)} and sent no beat within ${seconds(studio.heartbeatWaitMs)} ` +
        `of ${iso(start)}, so its upsert does not advance last_seen_at`,
    );
  },
};

/** What one instance reports wrong about the seal canary and the release, or nothing when it is all as expected. */
function canaryProblems(row: StudioInstance, kid: string, studio: StudioCheckContext): string[] {
  const problems: string[] = [];
  const name = row.instanceId;
  if (!row.keyringKids.includes(kid)) {
    problems.push(`${name} lists no Platform kid ${kid} in keyring_kids [${row.keyringKids.join(", ")}]`);
  }
  const canary = row.canary[kid];
  if (canary === undefined) problems.push(`${name} reports no canary for the Platform kid ${kid}`);
  else if (canary !== "ok") problems.push(`${name} reports canary ${canary} for the Platform kid ${kid}`);
  if (row.studioVersion !== studio.reportedVersion) {
    problems.push(
      `${name} reports Studio ${row.studioVersion}, and the release manifest's studio.reportedVersion is ${studio.reportedVersion}`,
    );
  }
  const supported = versionList(row.supportedContracts);
  if (supported !== versionList(studio.studioSupports)) {
    problems.push(
      `${name} supports contracts ${supported}, and the release manifest's studioSupports is ${versionList(studio.studioSupports)}`,
    );
  }
  return problems;
}

/**
 * studio-canary: within canaryWaitMs, every row seen in the last 2 minutes lists the kid of the key Platform runs with
 * in keyring_kids, reports canary[kid] = 'ok', and reports the studio_version the pinned build reports
 * and the supported_contracts of the release manifest.
 */
export const studioCanaryCheck: Check<StudioChecks> = {
  id: "studio-canary",
  async run({ studio }) {
    const kid = sealKeyId(studio.platformSealPublicKey());
    const problem = await poll(studio, studio.canaryWaitMs, async () => {
      const { rows } = await liveInstances(studio);
      if (rows.length === 0) return NO_LIVE_ROW;
      const problems = rows.flatMap((row) => canaryProblems(row, kid, studio));
      return problems.length === 0 ? undefined : problems.join("; ");
    });
    return problem === undefined ? PASSED : failed(`within ${seconds(studio.canaryWaitMs)}: ${problem}`);
  },
};

/** The change hint that the round trip sends; Studio reloads its whole snapshot on any hint. */
export const NOTIFY_PAYLOAD = '{"v":1,"kind":"settings"}';

/** Prints the database time, then sends the hint on libredb_bridge, which psql commits at once. */
export function notifyScript(): string {
  return `${resultQuery("sent", "to_jsonb((extract(epoch FROM now()) * 1000)::float8)")}\nNOTIFY libredb_bridge, '${NOTIFY_PAYLOAD}';\n`;
}

/**
 * bridge-notify-roundtrip: as libredb_studio, NOTIFY libredb_bridge, then wait until every live instance reports a
 * last_notification_at from the send on, which only a delivery on libredb_bridge moves. Studio stamps a
 * delivery with Date.now(), which has millisecond resolution, so a delivery within the millisecond of the send, whose
 * time PostgreSQL gives in microseconds, carries that millisecond.
 */
export const bridgeNotifyRoundtripCheck: Check<StudioChecks> = {
  id: "bridge-notify-roundtrip",
  async run({ studio }) {
    const result = await runScript(studio.sql, studio.login, notifyScript());
    const sent = parseResult(z.number(), parseResults(result.stdout).get("sent"), "notification send time");
    const sentMs = Math.floor(sent);
    let noRows = false;
    const problem = await poll(studio, studio.heartbeatWaitMs, async () => {
      const { rows } = await liveInstances(studio);
      noRows = rows.length === 0;
      const late = rows.filter((row) => row.lastNotificationAt === null || row.lastNotificationAt < sentMs);
      if (!noRows && late.length === 0) return undefined;
      return late
        .map(
          (row) =>
            `${row.instanceId} reported no newer last_notification_at within ${seconds(studio.heartbeatWaitMs)} ` +
            `(last ${row.lastNotificationAt === null ? "never" : iso(row.lastNotificationAt)})`,
        )
        .join("; ");
    });
    if (problem === undefined) return PASSED;
    if (noRows) return failed(`${NO_LIVE_ROW}, so no instance can receive a notification`);
    return failed(`after NOTIFY libredb_bridge at ${iso(sent)}, ${problem}`);
  },
};

/** The Studio checks, in the order verify runs them. */
export const STUDIO_CHECKS: readonly Check<StudioChecks>[] = [
  studioReadyCheck,
  studioHeartbeatCheck,
  studioCanaryCheck,
  bridgeNotifyRoundtripCheck,
];
