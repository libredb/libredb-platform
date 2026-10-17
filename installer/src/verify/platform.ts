// The Platform checks of `verify`: readiness asked from inside the network, the Auth.js sign-in redirect to Keycloak,
// the Admin API as Platform's service account requests it, the contract and the seal canary that Platform publishes
// in schema bridge, and the post-migration schema owners and role privileges of docs/platform-studio-integration.md.
// The HTTP checks run node scripts in one-shot containers of the Platform image (src/adapters/in-network-probe.ts),
// so they see the network, the names and the CA bundle that Platform sees. No script prints a token or a secret.
import { z } from "zod";
import { APP_CLIENT_IDS, ROLE_CLIENT_ID } from "../keycloak/desired";
import { sealKeyId } from "../secrets/seal-keys";
import { falseRows, type MatrixRow } from "../sql/matrix";
import { quoteLiteral } from "../sql/quote";
import { parseResult, parseResults, RESULT_PREFIX, resultQuery, runScript, type PsqlLogin, type SqlRunner } from "../sql/runner";
import { POSTGRES_NAMES } from "../state/immutable";
import type { Check, CheckOutcome } from "./catalogue";

/** One node script, run as an ES module from standard input in a one-shot container of the Platform image. */
export interface ProbeRequest {
  script: string;
  /** Variables the script reads, which never hold a secret. */
  env: Readonly<Record<string, string>>;
  /** An env file the container also receives, such as Platform's runtime env; a secret reaches a probe only so. */
  envFile?: string;
}

export interface ProbeResult {
  exitCode: number;
  /** The redacted standard output. */
  stdout: string;
  /** The redacted standard error. */
  stderr: string;
}

/** Runs probe scripts on the network that Platform and the edge share, with the CA bundle mounted. */
export interface ProbeRunner {
  run(request: ProbeRequest): Promise<ProbeResult>;
}

export interface PlatformCheckContext {
  probe: ProbeRunner;
  sql: SqlRunner;
  /** The admin role on database libredb, which can read every role's privileges. */
  admin: PsqlLogin;
  /** libredb_studio on database libredb, which reads the bridge as Studio does. */
  studio: PsqlLogin;
  /** Platform's public base URL, such as https://platform.example.com. */
  platformUrl: string;
  /** The readiness route as the network reaches it, such as http://platform:3000/api/health/ready. */
  readyUrl: string;
  /** The issuer Platform signs in with, `https://<auth>/realms/<realm>`. */
  issuer: string;
  /** Platform's runtime env file, which the Admin API probe runs with. */
  platformEnvFile: string;
  /** The contract versions of the release manifest's `platformPublishes`. */
  platformPublishes: readonly number[];
  /** BRIDGE_SEAL_PUBLIC_KEY as the installer gives it to Platform. */
  sealPublicKey: string;
  /** How long seal-canary-published waits for a Platform that has just started to publish its canary. */
  canaryWaitMs: number;
  sleep: (ms: number) => Promise<void>;
}

type PlatformChecks = { platform: PlatformCheckContext };

export const PASSED: CheckOutcome = { passed: true };
export const failed = (cause: string): CheckOutcome => ({ passed: false, cause });

const PROBE_TIMEOUT_MS = 15_000;

/**
 * A probe script: `body` fills `result` with what it sees, an error becomes `result.error`, and the script prints the
 * result as one result line, then exits.
 */
export function probeScript(name: string, body: string): string {
  return [
    `const timeout = () => AbortSignal.timeout(${PROBE_TIMEOUT_MS});`,
    "const result = {};",
    "try {",
    body,
    "} catch (error) {",
    "  result.error = String(error?.cause ?? error);",
    "}",
    `process.stdout.write(${JSON.stringify(`${RESULT_PREFIX} ${name} `)} + JSON.stringify(result) + "\\n", () => process.exit(0));`,
    "",
  ].join("\n");
}

/** Runs a probe and reads its result line, or throws naming the container's exit code and standard error. */
export async function probe<T extends z.ZodType>(
  context: { probe: ProbeRunner },
  name: string,
  request: ProbeRequest,
  schema: T,
): Promise<z.output<T>> {
  const result = await context.probe.run(request);
  const value = parseResults(result.stdout).get(name);
  if (value === undefined) {
    const stderr = result.stderr.trim();
    throw new Error(
      `the probe container exited with code ${result.exitCode} and printed no ${name} result${stderr === "" ? "" : `: ${stderr}`}`,
    );
  }
  return parseResult(schema, value, `${name} probe results`);
}

/** GETs PROBE_URL and reports its status and the start of its body. */
export const READY_SCRIPT = probeScript(
  "ready",
  [
    "  const response = await fetch(process.env.PROBE_URL, { signal: timeout() });",
    "  result.status = response.status;",
    "  result.body = (await response.text()).slice(0, 2000);",
  ].join("\n"),
);

export const readyResult = z
  .object({ status: z.number().int().optional(), body: z.string().optional(), error: z.string().optional() })
  .strict();

/** platform-ready: GET /api/health/ready answers 200 from inside the network. */
export const platformReadyCheck: Check<PlatformChecks> = {
  id: "platform-ready",
  async run({ platform }) {
    const url = platform.readyUrl;
    const result = await probe(platform, "ready", { script: READY_SCRIPT, env: { PROBE_URL: url } }, readyResult);
    if (result.error !== undefined) return failed(`GET ${url} failed: ${result.error}`);
    return result.status === 200 ? PASSED : failed(`GET ${url} answered ${result.status}: ${result.body}`);
  },
};

// The sign-in of Auth.js: the CSRF token with its cookie, then the form post that answers with the redirect to the
// provider's authorization endpoint.
const SIGNIN_SCRIPT = probeScript(
  "signin",
  [
    "  const base = process.env.PROBE_PLATFORM_URL;",
    '  const csrf = await fetch(base + "/api/auth/csrf", { redirect: "manual", signal: timeout() });',
    "  result.csrfStatus = csrf.status;",
    "  if (csrf.status === 200) {",
    '    const cookie = csrf.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");',
    "    const { csrfToken } = await csrf.json();",
    '    const signin = await fetch(base + "/api/auth/signin/keycloak", {',
    '      method: "POST",',
    '      redirect: "manual",',
    '      headers: { "content-type": "application/x-www-form-urlencoded", cookie },',
    '      body: new URLSearchParams({ csrfToken, callbackUrl: base + "/" }),',
    "      signal: timeout(),",
    "    });",
    "    result.status = signin.status;",
    '    result.location = signin.headers.get("location");',
    "  }",
  ].join("\n"),
);

const signinResult = z
  .object({
    csrfStatus: z.number().int().optional(),
    status: z.number().int().optional(),
    location: z.string().nullable().optional(),
    error: z.string().optional(),
  })
  .strict();

const SIGNIN = "the sign-in for provider keycloak";

/**
 * platform-signin-redirect: the Auth.js sign-in for provider keycloak, posted with its CSRF token through the edge,
 * answers 302 to the issuer's authorization endpoint for client libredb-platform with Platform's callback as
 * redirect_uri, which proves the issuer, the client and AUTH_URL together.
 */
export const platformSigninRedirectCheck: Check<PlatformChecks> = {
  id: "platform-signin-redirect",
  async run({ platform }) {
    const result = await probe(
      platform,
      "signin",
      { script: SIGNIN_SCRIPT, env: { PROBE_PLATFORM_URL: platform.platformUrl } },
      signinResult,
    );
    if (result.error !== undefined) return failed(`${SIGNIN} failed: ${result.error}`);
    if (result.csrfStatus !== 200) return failed(`GET /api/auth/csrf answered ${result.csrfStatus}`);
    if (result.status !== 302) return failed(`${SIGNIN} answered ${result.status}, not 302`);
    if (result.location == null) return failed(`${SIGNIN} answered 302 without a Location`);
    const authorization = `${platform.issuer}/protocol/openid-connect/auth`;
    const location = new URL(result.location, platform.platformUrl);
    if (`${location.origin}${location.pathname}` !== authorization) {
      return failed(`${SIGNIN} redirected to ${result.location}, not to ${authorization}`);
    }
    const clientId = location.searchParams.get("client_id");
    if (clientId !== APP_CLIENT_IDS.platform) {
      return failed(`${SIGNIN} sends client_id ${clientId}, not ${APP_CLIENT_IDS.platform}`);
    }
    const callback = `${platform.platformUrl}/api/auth/callback/keycloak`;
    const redirectUri = location.searchParams.get("redirect_uri");
    if (redirectUri !== callback) {
      return failed(`${SIGNIN} sends redirect_uri ${redirectUri}, and Platform's callback is ${callback}`);
    }
    return PASSED;
  },
};

// The Admin API as Platform calls it (src/shared/lib/keycloak/config.ts of Platform): KEYCLOAK_ADMIN_URL, or the
// issuer's base, is the base of both the token endpoint and the Admin API. The user create sends an empty
// representation: Keycloak checks the right to manage users first, so an account that has it gets 400 for the missing
// username, and no user is ever created.
const ADMIN_API_SCRIPT = probeScript(
  "admin-api",
  [
    "  const env = process.env;",
    "  const issuer = new URL(env.AUTH_KEYCLOAK_ISSUER);",
    "  const match = /^(.*)\\/realms\\/([^/]+)$/.exec(issuer.pathname);",
    '  if (match === null) throw new Error("AUTH_KEYCLOAK_ISSUER does not end in /realms/<realm>");',
    '  const base = env.KEYCLOAK_ADMIN_URL ? env.KEYCLOAK_ADMIN_URL.replace(/\\/+$/, "") : issuer.origin + match[1];',
    "  result.base = base;",
    "  result.realm = match[2];",
    '  const token = await fetch(base + "/realms/" + match[2] + "/protocol/openid-connect/token", {',
    '    method: "POST",',
    '    headers: { "content-type": "application/x-www-form-urlencoded" },',
    "    body: new URLSearchParams({",
    '      grant_type: "client_credentials",',
    "      client_id: env.AUTH_KEYCLOAK_ID,",
    "      client_secret: env.AUTH_KEYCLOAK_SECRET,",
    "    }),",
    "    signal: timeout(),",
    "  });",
    "  result.token = token.status;",
    "  if (token.status === 200) {",
    '    const headers = { authorization: "Bearer " + (await token.json()).access_token };',
    '    const admin = base + "/admin/realms/" + match[2];',
    `    const roleClientId = ${JSON.stringify(ROLE_CLIENT_ID)};`,
    '    const clients = await fetch(admin + "/clients?clientId=" + roleClientId, { headers, signal: timeout() });',
    "    result.clients = clients.status;",
    "    const holder = clients.status === 200",
    "      ? (await clients.json()).find((client) => client.clientId === roleClientId)",
    "      : undefined;",
    "    result.roleHolder = holder !== undefined;",
    "    if (holder !== undefined) {",
    '      const users = await fetch(admin + "/clients/" + encodeURIComponent(holder.id) + "/roles/admin/users", {',
    "        headers,",
    "        signal: timeout(),",
    "      });",
    "      result.roleUsers = users.status;",
    "    }",
    '    const create = await fetch(admin + "/users", {',
    '      method: "POST",',
    '      headers: { ...headers, "content-type": "application/json" },',
    '      body: "{}",',
    "      signal: timeout(),",
    "    });",
    "    result.create = create.status;",
    "  }",
  ].join("\n"),
);

const adminApiResult = z
  .object({
    base: z.string().optional(),
    realm: z.string().optional(),
    token: z.number().int().optional(),
    clients: z.number().int().optional(),
    roleHolder: z.boolean().optional(),
    roleUsers: z.number().int().optional(),
    create: z.number().int().optional(),
    error: z.string().optional(),
  })
  .strict();

/**
 * platform-admin-api: from a probe container with Platform's env, a libredb-platform client-credentials token gets
 * 200 on the users of role libredb:admin and 403 on a user create: the read-only directory access that the
 * realm-management roles view-users and view-clients give its service account.
 */
export const platformAdminApiCheck: Check<PlatformChecks> = {
  id: "platform-admin-api",
  async run({ platform }) {
    const result = await probe(
      platform,
      "admin-api",
      { script: ADMIN_API_SCRIPT, env: {}, envFile: platform.platformEnvFile },
      adminApiResult,
    );
    if (result.error !== undefined) return failed(`the Admin API probe failed: ${result.error}`);
    const admin = `${result.base}/admin/realms/${result.realm}`;
    if (result.token !== 200) {
      const token = `the ${APP_CLIENT_IDS.platform} client-credentials token from ${result.base}/realms/${result.realm}`;
      return failed(`${token} answered ${result.token}, expected 200`);
    }
    if (result.clients !== 200) {
      return failed(`GET ${admin}/clients?clientId=${ROLE_CLIENT_ID} answered ${result.clients}, expected 200`);
    }
    if (result.roleHolder !== true) {
      return failed(`realm ${result.realm} has no client ${ROLE_CLIENT_ID}, which holds the roles admin and user`);
    }
    if (result.roleUsers !== 200) {
      return failed(`GET ${admin}/clients/<${ROLE_CLIENT_ID}>/roles/admin/users answered ${result.roleUsers}, expected 200`);
    }
    if (result.create !== 403) {
      return failed(
        `POST ${admin}/users answered ${result.create}, expected 403: ` +
          `the ${APP_CLIENT_IDS.platform} service account may manage users`,
      );
    }
    return PASSED;
  },
};

/** The contract versions Studio may bind to: those with status current or deprecated. */
const BOUND_STATUSES = ["current", "deprecated"];

export function contractScript(): string {
  return `${resultQuery(
    "contract",
    "(SELECT coalesce(jsonb_agg(jsonb_build_object('version', c.version, 'status', c.status) ORDER BY c.version), '[]')" +
      " FROM bridge.contract c)",
  )}\n`;
}

const contractRows = z.array(z.object({ version: z.number().int(), status: z.string() }).strict());

export const versionList = (versions: Iterable<number>) => `[${[...new Set(versions)].sort((a, b) => a - b).join(", ")}]`;

/** bridge-contract: as libredb_studio, the versions bridge.contract lists as current or deprecated equal platformPublishes. */
export const bridgeContractCheck: Check<PlatformChecks> = {
  id: "bridge-contract",
  async run({ platform }) {
    const result = await runScript(platform.sql, platform.studio, contractScript());
    const rows = parseResult(contractRows, parseResults(result.stdout).get("contract"), "bridge.contract rows");
    const listed = versionList(rows.filter((row) => BOUND_STATUSES.includes(row.status)).map((row) => row.version));
    const published = versionList(platform.platformPublishes);
    if (listed === published) return PASSED;
    return failed(`bridge.contract lists ${listed} as current or deprecated, and the release manifest publishes ${published}`);
  },
};

export function canariesScript(): string {
  return `${resultQuery("canaries", "(SELECT coalesce(jsonb_agg(k.kid ORDER BY k.kid), '[]') FROM bridge.seal_canary_v1 k)")}\n`;
}

/** How often a check that waits for something asks again. */
export const POLL_MS = 2_000;

const CANARY_POLL_MS = POLL_MS;

/**
 * seal-canary-published: bridge.seal_canary_v1, read as libredb_studio, holds the kid of BRIDGE_SEAL_PUBLIC_KEY.
 * Platform publishes the canary just after it starts, so the check asks again until canaryWaitMs passed.
 */
export const sealCanaryPublishedCheck: Check<PlatformChecks> = {
  id: "seal-canary-published",
  async run({ platform }) {
    const kid = sealKeyId(platform.sealPublicKey);
    for (let waited = 0; ; waited += CANARY_POLL_MS) {
      const result = await runScript(platform.sql, platform.studio, canariesScript());
      const kids = parseResult(z.array(z.string()), parseResults(result.stdout).get("canaries"), "seal canary kids");
      if (kids.includes(kid)) return PASSED;
      if (waited >= platform.canaryWaitMs) {
        return failed(
          `bridge.seal_canary_v1 holds no canary for kid ${kid} of BRIDGE_SEAL_PUBLIC_KEY ` +
            `within ${platform.canaryWaitMs / 1000} s, only for [${kids.join(", ")}]`,
        );
      }
      await platform.sleep(CANARY_POLL_MS);
    }
  },
};

/** One privilege row after migration: whether a role holds a privilege on a schema or a table. */
export interface PrivilegeRow {
  id: string;
  kind: "schema" | "table";
  /** A schema name, or a table or view as `schema.name`. */
  object: string;
  role: string;
  privilege: string;
  held: boolean;
  /** The row as the cause names it when it is false. */
  row: string;
}

function privilegeRow(kind: PrivilegeRow["kind"], object: string, role: string, privilege: string, held: boolean): PrivilegeRow {
  const target = kind === "schema" ? `schema ${object}` : object;
  return {
    id: `${role}:${privilege}:${object}`,
    kind,
    object,
    role,
    privilege,
    held,
    row: `${role} has ${held ? "" : "no "}${privilege} on ${target}`,
  };
}

const { owner: OWNER, platform: PLATFORM_ROLE, studio: STUDIO_ROLE } = POSTGRES_NAMES.roles;

/** The owner of each schema. */
export const SCHEMA_OWNERS: readonly (readonly [string, string])[] = [
  ["platform", OWNER],
  ["bridge", OWNER],
  ["studio", STUDIO_ROLE],
];

/** The privilege rows that only exist once the migrations created schemas platform and bridge. */
export const BRIDGE_PRIVILEGE_ROWS: readonly PrivilegeRow[] = [
  privilegeRow("schema", "platform", STUDIO_ROLE, "USAGE", false),
  privilegeRow("table", "bridge.query_event", STUDIO_ROLE, "SELECT", false),
  privilegeRow("table", "bridge.query_events_v1", STUDIO_ROLE, "SELECT", false),
  privilegeRow("table", "bridge.query_events_v1", STUDIO_ROLE, "INSERT", true),
  privilegeRow("table", "bridge.query_event", PLATFORM_ROLE, "UPDATE", false),
  privilegeRow("table", "bridge.query_event", PLATFORM_ROLE, "DELETE", false),
  privilegeRow("table", "bridge.query_event", PLATFORM_ROLE, "TRUNCATE", false),
];

/**
 * The script that prints the owners of the three schemas and, for each privilege row, has_schema_privilege or
 * has_table_privilege of the role, or null when the role or the object does not exist.
 */
export function bridgePrivilegesScript(): string {
  const schemas = SCHEMA_OWNERS.map(([schema]) => quoteLiteral(schema)).join(", ");
  const rows = BRIDGE_PRIVILEGE_ROWS.map(
    (row) =>
      `(${[row.id, row.kind, row.object, row.role, row.privilege].map((value) => quoteLiteral(value)).join(", ")})`,
  ).join(",\n    ");
  return `${resultQuery(
    "bridge-privileges",
    `jsonb_build_object(
  'owners', (SELECT coalesce(jsonb_object_agg(n.nspname, pg_get_userbyid(n.nspowner)), '{}')
    FROM pg_catalog.pg_namespace n WHERE n.nspname IN (${schemas})),
  'privileges', (SELECT coalesce(jsonb_object_agg(v.id, CASE v.kind
      WHEN 'schema' THEN (SELECT has_schema_privilege(r.oid, n.oid, v.privilege)
        FROM pg_catalog.pg_roles r, pg_catalog.pg_namespace n WHERE r.rolname = v.role AND n.nspname = v.object)
      ELSE (SELECT has_table_privilege(r.oid, c.oid, v.privilege)
        FROM pg_catalog.pg_roles r, pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE r.rolname = v.role AND n.nspname = split_part(v.object, '.', 1) AND c.relname = split_part(v.object, '.', 2))
    END), '{}')
    FROM (VALUES ${rows}) AS v(id, kind, object, role, privilege)))`,
  )}\n`;
}

const bridgePrivilegeFacts = z
  .object({ owners: z.record(z.string(), z.string()), privileges: z.record(z.string(), z.boolean().nullable()) })
  .strict();

export type BridgePrivilegeFacts = z.output<typeof bridgePrivilegeFacts>;

/** Every owner and privilege row; a row whose role or object does not exist is false. */
export function evaluateBridgePrivileges(facts: BridgePrivilegeFacts): MatrixRow[] {
  return [
    ...SCHEMA_OWNERS.map(([schema, owner]) => ({
      row: `schema ${schema} is owned by ${owner}`,
      ok: facts.owners[schema] === owner,
    })),
    ...BRIDGE_PRIVILEGE_ROWS.map((row) => ({ row: row.row, ok: facts.privileges[row.id] === row.held })),
  ];
}

/** bridge-privileges: the schema owners and the post-migration rows, read by the admin role in database libredb. */
export const bridgePrivilegesCheck: Check<PlatformChecks> = {
  id: "bridge-privileges",
  async run({ platform }) {
    const result = await runScript(platform.sql, platform.admin, bridgePrivilegesScript());
    const value = parseResults(result.stdout).get("bridge-privileges");
    const facts = parseResult(bridgePrivilegeFacts, value, "bridge privilege facts");
    const rows = falseRows(evaluateBridgePrivileges(facts));
    return rows.length === 0 ? PASSED : failed(`false rows: ${rows.join("; ")}`);
  },
};

/** The Platform checks, in the order verify runs them. */
export const PLATFORM_CHECKS: readonly Check<PlatformChecks>[] = [
  platformReadyCheck,
  platformSigninRedirectCheck,
  platformAdminApiCheck,
  bridgeContractCheck,
  sealCanaryPublishedCheck,
  bridgePrivilegesCheck,
];
