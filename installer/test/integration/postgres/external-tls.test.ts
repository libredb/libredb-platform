// An external PostgreSQL 15 that serves TLS from a test CA, reached the way the preflight and postgres-provision steps
// reach a server outside the installation: psql in one-shot containers of the pinned release image with verify-full,
// trusting the first certificate of postgres.external.caBundleFile in preflight and the CA bundle that base builds
// afterwards, as an admin role with CREATEROLE and CREATEDB. It publishes no host port.
// LIBREDB_IT_PREFIX names the container, the network and the scratch directory (default libredb-it-ext), and
// LIBREDB_IT_POSTGRES_REPOSITORY the server image, tagged by major version (default docker.io/library/postgres).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerPsqlRunner } from "../../../src/adapters/psql-docker";
import { embeddedRelease } from "../../../src/cli/release";
import { parseInstallation, type LibreDBInstallation } from "../../../src/config/schema";
import { Redactor } from "../../../src/log/redact";
import { PreflightError } from "../../../src/preflight/docker-checks";
import { imageReference } from "../../../src/release/images";
import { renderPgHba } from "../../../src/render/compose";
import { generateSecret } from "../../../src/secrets/generate";
import { scramSha256Verifier } from "../../../src/secrets/scram";
import { V1_REPLICAS } from "../../../src/sql/checks";
import { falseRows } from "../../../src/sql/matrix";
import { APP_ROLES, renderDbaScript, ROLE_SPECS, type AppRole } from "../../../src/sql/provision";
import { quoteIdent, quoteLiteral } from "../../../src/sql/quote";
import { runScript, type PsqlLogin } from "../../../src/sql/runner";
import { emptyState } from "../../../src/state/store";
import { POSTGRES_NAMES } from "../../../src/state/immutable";
import {
  applyProvision,
  manualProvisionProblems,
  observeProvision,
  planProvisionRun,
  type ProvisionTarget,
} from "../../../src/steps/postgres-provision";
import {
  checkExternalPostgres,
  externalPostgresOf,
  preflightTrust,
  type ExternalPostgresTarget,
} from "../../../src/steps/preflight-external";
import { buildCaBundle, caBundleFiles, postgresCaBundleFile } from "../../../src/tls/bundle";
import { createCa } from "../../../src/tls/ca";
import { issueLeaf } from "../../../src/tls/leaf";

const PREFIX = process.env.LIBREDB_IT_PREFIX ?? "libredb-it-ext";
const REPOSITORY = process.env.LIBREDB_IT_POSTGRES_REPOSITORY ?? "docker.io/library/postgres";
const NETWORK = `${PREFIX}-net`;
// The server's container name, which is also the host name its certificate covers on the private network.
const SERVER = `${PREFIX}-pg15`;
const PSQL_IMAGE = imageReference(embeddedRelease().images.postgres, undefined);
const LONG = 10 * 60_000;

const scratch = mkdtempSync(join(tmpdir(), `${PREFIX}-`));
const superuserPassword = generateSecret();
const adminPassword = generateSecret();
const redactor = new Redactor();
// Every password this file generates, which must never reach the server log.
const generated: string[] = [superuserPassword, adminPassword];
const CORP_CA_FILE = join(scratch, "corp-db-ca.crt");

function docker(args: readonly string[], check = true): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  if (check && run.code !== 0) throw new Error(`docker ${args.join(" ")} exited with ${run.code}: ${run.stderr.trim()}`);
  return run;
}

function removeEverything(): void {
  docker(["rm", "--force", "--volumes", SERVER], false);
  const leftovers = docker(["ps", "--all", "--quiet", "--filter", `name=^${PREFIX}-psql-`]).stdout.split("\n").filter(Boolean);
  if (leftovers.length > 0) docker(["rm", "--force", ...leftovers], false);
  docker(["network", "rm", NETWORK], false);
}

/** A configuration of an external server, with or without postgres.external.caBundleFile. */
function config(withCaBundleFile: boolean): LibreDBInstallation {
  return parseInstallation({
    apiVersion: "install.libredb.org/v1",
    kind: "LibreDBInstallation",
    metadata: { name: "it" },
    mode: "docker",
    endpoints: { hosts: { platform: "platform.corp", studio: "studio.corp", auth: "auth.corp" } },
    postgres: {
      mode: "external",
      external: {
        host: SERVER,
        adminUser: "corp_dba",
        adminPasswordEnv: "LIBREDB_IT_PG_ADMIN_PASSWORD",
        ...(withCaBundleFile ? { caBundleFile: CORP_CA_FILE } : {}),
      },
    },
    platform: { organizationName: "Acme" },
  });
}

let internalCaPem = "";

const readText = (path: string) => readFileSync(path, "utf8");

/** The CA bundle that base installs for the configuration, which every app and the installer's psql trust. */
function installedBundle(installation: LibreDBInstallation): string {
  const postgres = postgresCaBundleFile(installation);
  const inputs = caBundleFiles(installation)
    .filter((source) => source !== postgres)
    .map((source) => ({ source, pem: readText(source) }));
  return buildCaBundle(internalCaPem, inputs, postgres === undefined ? [] : [{ source: postgres, pem: readText(postgres) }]);
}

/** What preflight trusts for the configuration: the first certificate of postgres.external.caBundleFile. */
function preflightPem(installation: LibreDBInstallation): string {
  const trust = preflightTrust(externalPostgresOf(installation), readText);
  if ("problem" in trust) throw new Error(trust.problem);
  return trust.pem;
}

/** A psql runner that trusts the given PEM file, as the runners of preflight and of the later steps do. */
function runnerTrusting(name: string, pem: string): DockerPsqlRunner {
  const file = join(scratch, "bundles", `${name}.crt`);
  writeFileSync(file, pem, { mode: 0o644 });
  return new DockerPsqlRunner({
    image: PSQL_IMAGE,
    network: NETWORK,
    caBundleFile: file,
    envDir: join(scratch, "env"),
    redactor,
    log: () => {},
    namePrefix: `${PREFIX}-psql`,
  });
}

const superuser: PsqlLogin = { host: SERVER, port: 5432, database: "postgres", user: "postgres", password: superuserPassword };
const admin: PsqlLogin = { host: SERVER, port: 5432, database: "postgres", user: "corp_dba", password: adminPassword };

function preflightTarget(runner: DockerPsqlRunner, login: PsqlLogin, provisioning: "installer" | "manual"): ExternalPostgresTarget {
  return { runner, login, provisioning, budget: { managedKeycloak: true, ...V1_REPLICAS }, now: () => Date.now() };
}

function freshPasswords(): Record<AppRole, string> {
  const passwords = Object.fromEntries(APP_ROLES.map((role) => [role, generateSecret()])) as Record<AppRole, string>;
  generated.push(...Object.values(passwords));
  for (const password of Object.values(passwords)) redactor.register(password);
  return passwords;
}

beforeAll(async () => {
  removeEverything();
  for (const dir of ["tls", "bundles"]) {
    mkdirSync(join(scratch, dir), { mode: 0o755 });
    chmodSync(join(scratch, dir), 0o755);
  }
  mkdirSync(join(scratch, "env"), { mode: 0o700 });
  const now = new Date();
  // The installation's own CA, which never signs an external server, and the CA of the customer's database team.
  internalCaPem = (await createCa({ commonName: `${PREFIX} internal CA`, now })).certPem;
  const corpCa = await createCa({ commonName: `${PREFIX} corp database CA`, now });
  const leaf = await issueLeaf(corpCa, [SERVER], now);
  writeFileSync(CORP_CA_FILE, corpCa.certPem, { mode: 0o644 });
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
  docker([
    "run",
    "--detach",
    "--name",
    SERVER,
    "--network",
    NETWORK,
    "--env-file",
    join(scratch, "server.env"),
    "--volume",
    `${join(scratch, "tls")}:/etc/libredb-it/source:ro`,
    "--entrypoint",
    "sh",
    `${REPOSITORY}:15`,
    "-c",
    [
      "install -d -m 0700 -o postgres -g postgres /etc/libredb-it/tls",
      "install -m 0600 -o postgres -g postgres /etc/libredb-it/source/server.key /etc/libredb-it/tls/server.key",
      "install -m 0644 -o postgres -g postgres /etc/libredb-it/source/server.crt /etc/libredb-it/tls/server.crt",
      "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/libredb-it/tls/server.crt " +
        "-c ssl_key_file=/etc/libredb-it/tls/server.key -c hba_file=/etc/libredb-it/source/pg_hba.conf " +
        "-c password_encryption=scram-sha-256 -c log_statement=all",
    ].join(" && "),
  ]);
  const deadline = Date.now() + 120_000;
  while (docker(["exec", SERVER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], false).code !== 0) {
    if (Date.now() > deadline) throw new Error(`${SERVER} did not become ready within 120 s`);
    await Bun.sleep(500);
  }
  // The customer's admin role, as a managed PostgreSQL service gives it: CREATEROLE and CREATEDB, no SUPERUSER.
  const verifier = scramSha256Verifier(adminPassword, crypto.getRandomValues(new Uint8Array(16)));
  await runScript(
    runnerTrusting("installed", installedBundle(config(true))),
    superuser,
    `CREATE ROLE ${quoteIdent(admin.user)} LOGIN PASSWORD ${quoteLiteral(verifier)} CREATEROLE CREATEDB;\n`,
  );
}, LONG);

afterAll(() => {
  removeEverything();
  rmSync(scratch, { recursive: true, force: true });
});

/** Drops what provisioning created, so each test starts from the customer's server as it was handed over. */
async function reset(): Promise<void> {
  await runScript(
    runnerTrusting("installed", installedBundle(config(true))),
    superuser,
    [
      'DROP DATABASE IF EXISTS "libredb" WITH (FORCE);',
      'DROP DATABASE IF EXISTS "keycloak" WITH (FORCE);',
      `DROP ROLE IF EXISTS ${APP_ROLES.map((role) => quoteIdent(ROLE_SPECS[role].name)).join(", ")};`,
      "",
    ].join("\n"),
  );
}

async function provisionError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the run to fail");
}

describe("an external PostgreSQL server", () => {
  test(
    "an external PostgreSQL 15 with a certificate from a test CA provisions with caBundleFile set and fails preflight with a certificate error without it",
    async () => {
      await reset();
      const withCa = config(true);
      await checkExternalPostgres(preflightTarget(runnerTrusting("preflight", preflightPem(withCa)), admin, "installer"));
      // The bundle base installs leads with the server's CA, the one certificate Prisma in the migrate job trusts.
      const runner = runnerTrusting("installed", installedBundle(withCa));
      expect(installedBundle(withCa).startsWith(preflightPem(withCa))).toBe(true);

      const state = emptyState();
      const target: ProvisionTarget = {
        runner,
        admin,
        server: { host: SERVER, port: 5432 },
        passwords: freshPasswords(),
        managedKeycloak: true,
        redactor,
      };
      const warnings: string[] = [];
      const first = planProvisionRun(await observeProvision(target), target, state);
      expect(first.filter((action) => action.kind === "create-role").map((action) => action.summary)).toEqual([
        "create role libredb_owner",
        "create role libredb_platform",
        "create role libredb_studio",
        "create role libredb_keycloak",
      ]);
      // applyProvision ends with the privilege matrix and the LISTEN/NOTIFY round trip as libredb_studio.
      await applyProvision(first, target, state, (warning) => warnings.push(warning));
      // The admin cannot grant pg_read_all_data, so provisioning names the backup role it could not create.
      expect(warnings).toHaveLength(1);
      expect(falseRows((await observeProvision(target)).rows)).toEqual([]);
      expect(planProvisionRun(await observeProvision(target), target, state)).toEqual([]);

      // Without caBundleFile, preflight names the setting, and a client that trusts the bundle base would install
      // instead, the internal CA alone, fails the TLS handshake.
      const withoutCa = config(false);
      expect(preflightTrust(externalPostgresOf(withoutCa), readText)).toEqual({
        problem:
          `postgres.external.caBundleFile is not set, so the certificate of the external PostgreSQL server ${SERVER}:5432 ` +
          "cannot be verified with sslmode=verify-full: set it to the CA that issued that certificate",
      });
      const without = runnerTrusting("without", installedBundle(withoutCa));
      const error = await provisionError(() => checkExternalPostgres(preflightTarget(without, admin, "installer")));
      expect(error).toBeInstanceOf(PreflightError);
      expect((error as PreflightError).exitCode).toBe(3);
      const message = (error as PreflightError).message;
      expect(message).toContain(`cannot connect to the external PostgreSQL server ${SERVER}:5432 as corp_dba`);
      expect(message).toContain("certificate verify failed");
      expect(message).toContain("postgres.external.caBundleFile");
    },
    LONG,
  );

  test(
    "with provisioning manual, the DBA script run by the admin role provisions the server, and preflight, the privilege matrix and the round trip pass as the app roles",
    async () => {
      await reset();
      const runner = runnerTrusting("installed", installedBundle(config(true)));
      const passwords = freshPasswords();
      const server = { host: SERVER, port: 5432 };
      const target = { runner, server, passwords, managedKeycloak: true };
      expect(await manualProvisionProblems(target)).toEqual([
        "libredb_owner does not log in with the password the installer stored",
        "libredb_platform does not log in with the password the installer stored",
        "libredb_studio does not log in with the password the installer stored",
        "libredb_keycloak does not log in with the password the installer stored",
      ]);

      // The DBA runs the script with psql as their own admin role; the installer never sees that credential.
      await runScript(runner, admin, renderDbaScript({ passwords, managedKeycloak: true, server }));
      expect(await manualProvisionProblems(target)).toEqual([]);
      const platform: PsqlLogin = {
        ...server,
        database: POSTGRES_NAMES.database,
        user: POSTGRES_NAMES.roles.platform,
        password: passwords.platform,
      };
      await checkExternalPostgres(preflightTarget(runnerTrusting("preflight", preflightPem(config(true))), platform, "manual"));

      // A drifted server names the false rows as an app role reads them.
      await runScript(runner, superuser, 'ALTER ROLE "libredb_owner" CONNECTION LIMIT 50;\n');
      expect(await manualProvisionProblems(target)).toEqual(["libredb_owner has connection limit 5"]);
      // Running the script again converges it.
      await runScript(runner, admin, renderDbaScript({ passwords, managedKeycloak: true, server }));
      expect(await manualProvisionProblems(target)).toEqual([]);
    },
    LONG,
  );

  test(
    "no generated cleartext password reaches the server log",
    () => {
      const logs = docker(["logs", SERVER]);
      const text = `${logs.stdout}${logs.stderr}`;
      expect(text.includes("PASSWORD 'SCRAM-SHA-256$4096:")).toBe(true);
      for (const [index, password] of generated.entries()) {
        expect({ password: index, found: text.includes(password) }).toEqual({ password: index, found: false });
      }
    },
    LONG,
  );
});
