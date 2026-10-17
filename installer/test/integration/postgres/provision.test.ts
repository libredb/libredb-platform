// Provisions real PostgreSQL servers through the Docker psql runner, as the postgres-provision step does: one server
// per major version on a private internal network, serving TLS from a test CA with the hostssl-only pg_hba.conf of
// the managed server, and psql in one-shot containers of the pinned release image. It publishes no host port.
// LIBREDB_IT_PREFIX names the containers, the network and the scratch directory (default libredb-it-pg), and
// LIBREDB_IT_POSTGRES_REPOSITORY the server images, tagged by major version (default docker.io/library/postgres).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerPsqlRunner } from "../../../src/adapters/psql-docker";
import { embeddedRelease } from "../../../src/cli/release";
import { Redactor } from "../../../src/log/redact";
import { imageReference } from "../../../src/release/images";
import { renderPgHba } from "../../../src/render/compose";
import { generateSecret } from "../../../src/secrets/generate";
import { scramSha256Verifier } from "../../../src/secrets/scram";
import { PostgresCheckError } from "../../../src/sql/checks";
import { falseRows } from "../../../src/sql/matrix";
import { APP_ROLES, renderProvisionScript, ROLE_SPECS, roleVerifiers, type AppRole } from "../../../src/sql/provision";
import { quoteIdent, quoteLiteral, quotePsqlArgument } from "../../../src/sql/quote";
import { parseResults, runScript, type PsqlLogin } from "../../../src/sql/runner";
import { emptyState, type InstallerState } from "../../../src/state/store";
import {
  applyProvision,
  observeProvision,
  planProvisionRun,
  type ProvisionTarget,
} from "../../../src/steps/postgres-provision";
import { createCa } from "../../../src/tls/ca";
import { issueLeaf } from "../../../src/tls/leaf";

const PREFIX = process.env.LIBREDB_IT_PREFIX ?? "libredb-it-pg";
const REPOSITORY = process.env.LIBREDB_IT_POSTGRES_REPOSITORY ?? "docker.io/library/postgres";
const NETWORK = `${PREFIX}-net`;
const MAJORS = [14, 15, 16, 17, 18] as const;
const SUPPORTED = [15, 16, 17, 18] as const;
const PSQL_IMAGE = imageReference(embeddedRelease().images.postgres, undefined);
const LONG = 20 * 60_000;

type Major = (typeof MAJORS)[number];

const scratch = mkdtempSync(join(tmpdir(), `${PREFIX}-`));
const superuserPassword = generateSecret();
const adminPassword = generateSecret();
const redactor = new Redactor();
// Every password this file generates, which must never reach a server log.
const generated: string[] = [superuserPassword, adminPassword];

const hostOf = (major: Major) => `${PREFIX}-pg${major}`;
const containerOf = hostOf;

function docker(args: readonly string[], check = true): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`docker ${args.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

function removeEverything(): void {
  for (const major of MAJORS) docker(["rm", "--force", "--volumes", containerOf(major)], false);
  const leftovers = docker(["ps", "--all", "--quiet", "--filter", `name=^${PREFIX}-psql-`]).stdout.split("\n").filter(Boolean);
  if (leftovers.length > 0) docker(["rm", "--force", ...leftovers], false);
  docker(["network", "rm", NETWORK], false);
}

const runner = new DockerPsqlRunner({
  image: PSQL_IMAGE,
  network: NETWORK,
  caBundleFile: join(scratch, "tls", "ca.crt"),
  envDir: join(scratch, "env"),
  redactor,
  log: () => {},
  namePrefix: `${PREFIX}-psql`,
});

function login(major: Major, user: string, password: string, database = "postgres"): PsqlLogin {
  return { host: hostOf(major), port: 5432, database, user, password };
}

const superuser = (major: Major) => login(major, "postgres", superuserPassword);

async function startServer(major: Major): Promise<void> {
  docker([
    "run",
    "--detach",
    "--name",
    containerOf(major),
    "--network",
    NETWORK,
    "--env-file",
    join(scratch, "server.env"),
    "--volume",
    `${join(scratch, "tls")}:/etc/libredb-it/source:ro`,
    "--entrypoint",
    "sh",
    `${REPOSITORY}:${major}`,
    "-c",
    [
      // The server key must belong to the postgres user with mode 0600, which a bind mount cannot give it.
      "install -d -m 0700 -o postgres -g postgres /etc/libredb-it/tls",
      "install -m 0600 -o postgres -g postgres /etc/libredb-it/source/server.key /etc/libredb-it/tls/server.key",
      "install -m 0644 -o postgres -g postgres /etc/libredb-it/source/server.crt /etc/libredb-it/tls/server.crt",
      "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/libredb-it/tls/server.crt " +
        "-c ssl_key_file=/etc/libredb-it/tls/server.key -c hba_file=/etc/libredb-it/source/pg_hba.conf " +
        "-c password_encryption=scram-sha-256 -c log_statement=all",
    ].join(" && "),
  ]);
}

async function waitReady(major: Major): Promise<void> {
  const deadline = Date.now() + 120_000;
  // TCP on loopback opens only after the image's first initialization, like the managed server's healthcheck.
  while (docker(["exec", containerOf(major), "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], false).code !== 0) {
    if (Date.now() > deadline) throw new Error(`${containerOf(major)} did not become ready within 120 s`);
    await Bun.sleep(500);
  }
}

beforeAll(async () => {
  removeEverything();
  mkdirSync(join(scratch, "tls"), { mode: 0o755 });
  chmodSync(join(scratch, "tls"), 0o755);
  mkdirSync(join(scratch, "env"), { mode: 0o700 });
  const now = new Date();
  const ca = await createCa({ commonName: `${PREFIX} test CA`, now });
  const leaf = await issueLeaf(ca, MAJORS.map(hostOf), now);
  writeFileSync(join(scratch, "tls", "ca.crt"), ca.certPem, { mode: 0o644 });
  writeFileSync(join(scratch, "tls", "server.crt"), leaf.certPem, { mode: 0o644 });
  // A throwaway test key, copied into the server container with mode 0600 at start.
  writeFileSync(join(scratch, "tls", "server.key"), leaf.keyPem, { mode: 0o644 });
  writeFileSync(join(scratch, "tls", "pg_hba.conf"), renderPgHba(), { mode: 0o644 });
  writeFileSync(
    join(scratch, "server.env"),
    `POSTGRES_PASSWORD=${superuserPassword}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256\n`,
    { mode: 0o600 },
  );
  docker(["network", "create", "--internal", NETWORK]);
  await Promise.all(MAJORS.map(startServer));
  await Promise.all(MAJORS.map(waitReady));
}, LONG);

afterAll(() => {
  removeEverything();
  rmSync(scratch, { recursive: true, force: true });
});

type AdminKind = "superuser" | "createrole" | "createrole-read-all-data";

const ADMIN_ROLE = "it_admin";

/** Drops what provisioning and the admin setup created, so every admin kind starts from a fresh server. */
async function reset(major: Major): Promise<void> {
  await runScript(
    runner,
    superuser(major),
    [
      'DROP DATABASE IF EXISTS "libredb" WITH (FORCE);',
      'DROP DATABASE IF EXISTS "keycloak" WITH (FORCE);',
      `DROP ROLE IF EXISTS ${APP_ROLES.map((role) => quoteIdent(ROLE_SPECS[role].name)).join(", ")};`,
      `DROP ROLE IF EXISTS ${quoteIdent(ADMIN_ROLE)};`,
      "",
    ].join("\n"),
  );
}

async function adminLogin(major: Major, kind: AdminKind): Promise<PsqlLogin> {
  if (kind === "superuser") return superuser(major);
  const verifier = scramSha256Verifier(adminPassword, crypto.getRandomValues(new Uint8Array(16)));
  const statements = [`CREATE ROLE ${quoteIdent(ADMIN_ROLE)} LOGIN PASSWORD ${quoteLiteral(verifier)} CREATEROLE CREATEDB;`];
  if (kind === "createrole-read-all-data") {
    statements.push(`GRANT pg_read_all_data TO ${quoteIdent(ADMIN_ROLE)} WITH ADMIN OPTION;`);
  }
  await runScript(runner, superuser(major), `${statements.join("\n")}\n`);
  return login(major, ADMIN_ROLE, adminPassword);
}

function freshPasswords(): Record<AppRole, string> {
  const passwords = Object.fromEntries(APP_ROLES.map((role) => [role, generateSecret()])) as Record<AppRole, string>;
  generated.push(...Object.values(passwords));
  for (const password of Object.values(passwords)) redactor.register(password);
  return passwords;
}

function target(major: Major, admin: PsqlLogin, passwords: Record<AppRole, string>): ProvisionTarget {
  return { runner, admin, server: { host: hostOf(major), port: 5432 }, passwords, managedKeycloak: true, redactor };
}

/** Provisions with an empty plan as the graph does: observe, plan, and apply only when the plan has actions. */
async function provision(provisionTarget: ProvisionTarget, state: InstallerState) {
  const warnings: string[] = [];
  const actions = planProvisionRun(await observeProvision(provisionTarget), provisionTarget, state);
  if (actions.length > 0) await applyProvision(actions, provisionTarget, state, (warning) => warnings.push(warning));
  return { actions, warnings };
}

// Read as the superuser: every catalog row provisioning writes, with its xmin, which changes whenever a statement
// rewrites the row even with equal values. The verifiers are compared by digest, because the redactor masks them.
const SNAPSHOT = `
SELECT 'libredb-result catalog ' || jsonb_build_object(
  'authid', (SELECT jsonb_object_agg(rolname, jsonb_build_object('xmin', xmin::text, 'password', md5(rolpassword)))
               FROM pg_catalog.pg_authid WHERE rolname LIKE 'libredb\\_%'),
  'settings', (SELECT jsonb_agg(jsonb_build_object('xmin', s.xmin::text, 'role', r.rolname, 'config', s.setconfig)
                   ORDER BY r.rolname, s.setdatabase)
                 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
                WHERE r.rolname LIKE 'libredb\\_%'),
  'databases', (SELECT jsonb_object_agg(datname, jsonb_build_object('xmin', xmin::text, 'owner', datdba::regrole::text,
                  'encoding', pg_encoding_to_char(encoding), 'acl', datacl::text))
                  FROM pg_catalog.pg_database WHERE datname IN ('libredb', 'keycloak'))
)::text;
\\connect libredb
SELECT 'libredb-result schemas ' || jsonb_object_agg(nspname, jsonb_build_object('xmin', xmin::text,
         'owner', nspowner::regrole::text, 'acl', nspacl::text))::text
  FROM pg_catalog.pg_namespace WHERE nspname IN ('public', 'studio');
`;

interface Catalog {
  authid: Record<string, { xmin: string; password: string }>;
  settings: { xmin: string; role: string; config: string[] }[];
  databases: Record<string, { xmin: string; owner: string; encoding: string; acl: string }>;
  schemas: Record<string, { xmin: string; owner: string; acl: string | null }>;
}

async function catalog(major: Major): Promise<Catalog> {
  const results = parseResults((await runScript(runner, superuser(major), SNAPSHOT)).stdout);
  return { ...(results.get("catalog") as Omit<Catalog, "schemas">), schemas: results.get("schemas") as Catalog["schemas"] };
}

/** The catalog without transaction ids and verifiers, which differ between any two installs. */
function shape(snapshot: Catalog) {
  return {
    roles: Object.keys(snapshot.authid).sort(),
    settings: snapshot.settings.map(({ role, config }) => ({ role, config })),
    databases: Object.fromEntries(
      Object.entries(snapshot.databases).map(([name, { owner, encoding, acl }]) => [name, { owner, encoding, acl }]),
    ),
    schemas: Object.fromEntries(Object.entries(snapshot.schemas).map(([name, { owner, acl }]) => [name, { owner, acl }])),
  };
}

describe("PostgreSQL provisioning", () => {
  test(
    "provisioning twice on PostgreSQL 15, 16, 17 and 18, as a superuser and as a CREATEROLE CREATEDB admin, leaves every matrix row true and the second run changes nothing",
    async () => {
      for (const major of SUPPORTED) {
        const shapes: Partial<Record<AdminKind, ReturnType<typeof shape>>> = {};
        for (const kind of ["superuser", "createrole", "createrole-read-all-data"] as const) {
          const where = `PostgreSQL ${major} as ${kind}`;
          await reset(major);
          const admin = await adminLogin(major, kind);
          const state = emptyState();
          const provisionTarget = target(major, admin, freshPasswords());

          const first = await provision(provisionTarget, state);
          expect({ where, created: first.actions.filter((action) => action.kind === "create-role").length }).toEqual({
            where,
            created: kind === "createrole" ? 4 : 5,
          });
          expect({ where, warnings: first.warnings.length }).toEqual({ where, warnings: kind === "createrole" ? 1 : 0 });
          expect({ where, recorded: state.ownership.map((record) => record.name).sort() }).toEqual({
            where,
            recorded: [
              "keycloak",
              "libredb",
              ...(kind === "createrole" ? [] : ["libredb_backup"]),
              "libredb_keycloak",
              "libredb_owner",
              "libredb_platform",
              "libredb_studio",
            ],
          });

          const observed = await observeProvision(provisionTarget);
          expect({ where, falseRows: falseRows(observed.rows) }).toEqual({ where, falseRows: [] });
          expect({ where, logins: observed.logins }).toEqual({
            where,
            logins: Object.fromEntries(
              APP_ROLES.filter((role) => kind !== "createrole" || role !== "backup").map((role) => [role, true]),
            ),
          });

          const before = await catalog(major);
          const second = await provision(provisionTarget, state);
          expect({ where, second: second.actions }).toEqual({ where, second: [] });
          expect({ where, catalog: await catalog(major) }).toEqual({ where, catalog: before });

          // Re-running the whole script on the converged server executes no ALTER ROLE: no role row and no role
          // setting is rewritten, because every attribute, password and setting statement is guarded.
          await runScript(
            runner,
            admin,
            renderProvisionScript({
              verifiers: roleVerifiers(provisionTarget.passwords),
              managedKeycloak: true,
              resetPasswords: [],
            }),
          );
          const rerun = await catalog(major);
          expect({ where, authid: rerun.authid, settings: rerun.settings }).toEqual({
            where,
            authid: before.authid,
            settings: before.settings,
          });
          shapes[kind] = shape(rerun);
        }
        // The non-superuser path grants itself memberships and uses SET ROLE, and still gives the same result.
        expect({ major, shape: shapes["createrole-read-all-data"] }).toEqual({ major, shape: shapes.superuser });
      }
    },
    LONG,
  );

  test(
    "PostgreSQL 14 fails with exit 3 naming the version",
    async () => {
      const provisionTarget = target(14, superuser(14), freshPasswords());
      const observed = await observeProvision(provisionTarget);
      let error: unknown;
      try {
        planProvisionRun(observed, provisionTarget, emptyState());
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PostgresCheckError);
      expect((error as PostgresCheckError).exitCode).toBe(3);
      expect((error as PostgresCheckError).message).toContain("the server runs PostgreSQL 14.");
    },
    LONG,
  );

  test(
    "a stored password that no longer logs in is set again for that role only",
    async () => {
      await reset(18);
      const state = emptyState();
      const passwords = freshPasswords();
      const provisionTarget = target(18, superuser(18), passwords);
      await provision(provisionTarget, state);
      const before = await catalog(18);

      const rotated = { ...passwords, platform: generateSecret() };
      generated.push(rotated.platform);
      const rotatedTarget = { ...provisionTarget, passwords: rotated };
      const { actions } = await provision(rotatedTarget, state);
      expect(actions.map((action) => action.summary)).toEqual([
        "set the password of role libredb_platform, which does not log in with the stored one",
      ]);
      const after = await catalog(18);
      for (const [role, row] of Object.entries(after.authid)) {
        expect({ role, changed: row.password !== before.authid[role]?.password }).toEqual({
          role,
          changed: role === "libredb_platform",
        });
      }
      expect((await provision(rotatedTarget, state)).actions).toEqual([]);
    },
    LONG,
  );

  test(
    "a drifted server converges back to the PostgreSQL bootstrap, and the plan names the false rows",
    async () => {
      await reset(18);
      const state = emptyState();
      const provisionTarget = target(18, superuser(18), freshPasswords());
      await provision(provisionTarget, state);
      await runScript(
        runner,
        superuser(18),
        [
          'ALTER ROLE "libredb_owner" CONNECTION LIMIT 50 CREATEDB;',
          `ALTER ROLE "libredb_studio" IN DATABASE "libredb" SET idle_session_timeout = '5min';`,
          `ALTER ROLE "libredb_studio" SET idle_session_timeout = '1min';`,
          'ALTER ROLE "libredb_platform" IN DATABASE "libredb" RESET search_path;',
          'GRANT CREATE ON DATABASE "libredb" TO "libredb_platform";',
          'GRANT CONNECT ON DATABASE "libredb" TO PUBLIC, "libredb_keycloak";',
          "\\connect libredb",
          'GRANT USAGE ON SCHEMA "studio" TO "libredb_platform";',
          "GRANT USAGE ON SCHEMA public TO PUBLIC;",
          "",
        ].join("\n"),
      );
      const rows = [
        "libredb_owner has no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS",
        "libredb_owner has connection limit 5",
        "PUBLIC has no privilege on database libredb",
        "libredb_platform has no CREATE on database libredb",
        "libredb_keycloak has no CONNECT on database libredb",
        "PUBLIC has no privilege on schema public",
        "libredb_platform has no USAGE on schema studio",
        "libredb_platform has search_path=platform in database libredb",
        "libredb_studio has no idle_session_timeout",
      ];
      const { actions } = await provision(provisionTarget, state);
      expect(actions).toEqual([
        { kind: "converge", rows, summary: `converge Platform's PostgreSQL bootstrap, where these rows are false: ${rows.join("; ")}` },
      ]);
      expect(falseRows((await observeProvision(provisionTarget)).rows)).toEqual([]);
      expect((await provision(provisionTarget, state)).actions).toEqual([]);
    },
    LONG,
  );

  test(
    "a role that exists but is not recorded in the state stops provisioning with exit 3 naming it",
    async () => {
      await reset(18);
      await runScript(runner, superuser(18), 'CREATE ROLE "libredb_studio" LOGIN;\n');
      const provisionTarget = target(18, superuser(18), freshPasswords());
      const observed = await observeProvision(provisionTarget);
      expect(() => planProvisionRun(observed, provisionTarget, emptyState())).toThrow(
        "role libredb_studio exists on the PostgreSQL server, but this installation did not create it",
      );
    },
    LONG,
  );

  test(
    "quoted identifiers, literals and psql arguments reach the server unchanged",
    async () => {
      const values = ['a"b', "it's", "back\\slash", "both \"quotes' and \\ backslash\\", "'; DROP ROLE postgres; --"];
      const script = values
        .map((value, index) =>
          [
            `\\set value${index} ${quotePsqlArgument(value)}`,
            `CREATE TEMP TABLE t${index} (${quoteIdent(value)} int);`,
            `SELECT 'libredb-result v${index} ' || jsonb_build_object('literal', ${quoteLiteral(value)}, 'argument', :'value${index}',` +
              ` 'identifier', (SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid = 't${index}'::regclass AND attnum = 1))::text;`,
          ].join("\n"),
        )
        .join("\n");
      const results = parseResults((await runScript(runner, superuser(18), `${script}\n`)).stdout);
      for (const [index, value] of values.entries()) {
        expect(results.get(`v${index}`)).toEqual({ literal: value, argument: value, identifier: value });
      }
    },
    LONG,
  );

  test(
    "no generated cleartext password reaches a server log, which records the SCRAM verifiers instead",
    () => {
      for (const major of SUPPORTED) {
        const logs = docker(["logs", containerOf(major)]);
        const text = `${logs.stdout}${logs.stderr}`;
        expect({ major, verifiers: text.includes("PASSWORD 'SCRAM-SHA-256$4096:") }).toEqual({ major, verifiers: true });
        for (const [index, password] of generated.entries()) {
          expect({ major, password: index, found: text.includes(password) }).toEqual({ major, password: index, found: false });
        }
      }
    },
    LONG,
  );
});
