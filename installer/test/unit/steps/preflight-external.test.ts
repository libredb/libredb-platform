import { beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { parseInstallation, type DockerInstallation, type ExternalPostgres } from "../../../src/config/schema";
import { hashInputs } from "../../../src/engine/graph";
import { REDACTED, Redactor } from "../../../src/log/redact";
import { computeDesired } from "../../../src/model/desired";
import { PreflightError } from "../../../src/preflight/docker-checks";
import { V1_REPLICAS } from "../../../src/sql/checks";
import type { PostgresFacts } from "../../../src/sql/matrix";
import type { PsqlLogin, PsqlResult } from "../../../src/sql/runner";
import { emptyState } from "../../../src/state/store";
import type { DockerContext } from "../../../src/steps/docker-context";
import { preflightDockerStep, type PreflightObservation } from "../../../src/steps/preflight-docker";
import {
  AdminPasswordMissingError,
  adminLoginOrSkip,
  checkExternalPostgres,
  externalPostgresProblems,
  PostgresAdminAccess,
  preflightTrust,
  preflightStep,
  type ExternalPostgresTarget,
  type PostgresAdminOptions,
} from "../../../src/steps/preflight-external";
import { createCa, type CertificateAuthority } from "../../../src/tls/ca";
import { manifestFixture } from "../release/fixture";
import { convergedFacts, fakeRunner, freshFacts, observationOutput } from "../sql/fixture";

const EXTERNAL: ExternalPostgres = {
  host: "pg.corp.example",
  port: 5432,
  adminUser: "corp_dba",
  adminPasswordEnv: "LIBREDB_PG_ADMIN_PASSWORD",
  provisioning: "installer",
};

const USE = { needs: "postgres-provision", skipped: "postgres-provision was skipped" };

function access(overrides: Partial<PostgresAdminOptions> = {}) {
  const prompts: string[] = [];
  const redactor = new Redactor();
  const options: PostgresAdminOptions = {
    external: EXTERNAL,
    redactor,
    sources: { env: {}, readFile: () => undefined },
    isTTY: () => false,
    prompt: async (question) => {
      prompts.push(question);
      return "typed-password";
    },
    ...overrides,
  };
  return { access: new PostgresAdminAccess(options), prompts, redactor: options.redactor };
}

describe("PostgresAdminAccess", () => {
  test("reads the password that the configured variable holds, once per run, and registers it with the redactor", () => {
    const env: Record<string, string | undefined> = { LIBREDB_PG_ADMIN_PASSWORD: "env-password" };
    const { access: admin, redactor } = access({ sources: { env, readFile: () => undefined } });
    expect(admin.supplied()).toEqual({
      host: "pg.corp.example",
      port: 5432,
      database: "postgres",
      user: "corp_dba",
      password: "env-password",
    });
    expect(redactor.redact("x env-password y")).toBe(`x ${REDACTED} y`);
    env.LIBREDB_PG_ADMIN_PASSWORD = undefined;
    expect(admin.supplied()?.password).toBe("env-password");
  });

  test("reads the configured file", () => {
    const external = { ...EXTERNAL, adminPasswordEnv: undefined, adminPasswordFile: "/root/pg-admin" };
    const { access: admin } = access({
      external,
      sources: { env: {}, readFile: (path) => (path === "/root/pg-admin" ? "file-password\n" : undefined) },
    });
    expect(admin.supplied()?.password).toBe("file-password");
  });

  test("without a supplied password and without a terminal, a step that needs it exits 2 naming how to supply it", async () => {
    const { access: admin, prompts } = access();
    expect(admin.supplied()).toBeUndefined();
    const error = await admin.require("postgres-provision").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdminPasswordMissingError);
    expect((error as AdminPasswordMissingError).exitCode).toBe(2);
    expect((error as Error).message).toBe(
      "postgres-provision needs the password of the admin role corp_dba of the external PostgreSQL server " +
        "pg.corp.example:5432, and the environment variable LIBREDB_PG_ADMIN_PASSWORD that " +
        "postgres.external.adminPasswordEnv names is not set; set it, or run on a terminal to be asked for it",
    );
    expect(prompts).toEqual([]);
  });

  test("on a terminal it asks once with masked entry, and keeps the answer for the rest of the run", async () => {
    const { access: admin, prompts, redactor } = access({ isTTY: () => true });
    expect((await admin.require("preflight")).password).toBe("typed-password");
    expect((await admin.require("postgres-provision")).password).toBe("typed-password");
    expect(admin.supplied()?.password).toBe("typed-password");
    expect(prompts).toEqual(["Password of the admin role corp_dba of the external PostgreSQL server pg.corp.example:5432: "]);
    expect(redactor.redact("typed-password")).toBe(REDACTED);
  });

  test("refuses an empty answer and serves only provisioning installer", async () => {
    const { access: admin } = access({ isTTY: () => true, prompt: async () => "" });
    await expect(admin.require("preflight")).rejects.toThrow(
      "no password of the admin role corp_dba of the external PostgreSQL server pg.corp.example:5432 was entered",
    );
    const manual = { host: "pg.corp.example", port: 5432, provisioning: "manual" as const };
    expect(() => access({ external: manual })).toThrow(
      "only provisioning installer reaches the admin role of an external PostgreSQL server",
    );
    expect(access({ sources: { env: { LIBREDB_PG_ADMIN_PASSWORD: "x" }, readFile: () => undefined } }).access.missing()).toBe(
      "it is supplied",
    );
  });
});

describe("adminLoginOrSkip", () => {
  test("uses a supplied password whether or not the inputs changed", async () => {
    const env = { LIBREDB_PG_ADMIN_PASSWORD: "env-password" };
    const { access: admin } = access({ sources: { env, readFile: () => undefined } });
    expect(await adminLoginOrSkip(admin, USE, true)).toEqual({ login: expect.objectContaining({ password: "env-password" }) });
  });

  test("with unchanged inputs and no password, the step skips with a note that holds no secret", async () => {
    const { access: admin, prompts } = access({ isTTY: () => true });
    expect(await adminLoginOrSkip(admin, USE, true)).toEqual({
      note:
        "postgres-provision was skipped, because its inputs are unchanged since it last succeeded and no password of " +
        "the admin role corp_dba of the external PostgreSQL server pg.corp.example:5432 is supplied: the environment " +
        "variable LIBREDB_PG_ADMIN_PASSWORD that postgres.external.adminPasswordEnv names is not set",
    });
    expect(prompts).toEqual([]);
  });

  test("with changed inputs and no password, it asks on a terminal and exits 2 without one", async () => {
    const onTerminal = access({ isTTY: () => true });
    expect(await adminLoginOrSkip(onTerminal.access, USE, false)).toEqual({
      login: expect.objectContaining({ password: "typed-password" }),
    });
    expect(onTerminal.prompts).toHaveLength(1);
    await expect(adminLoginOrSkip(access().access, USE, false)).rejects.toThrow("postgres-provision needs the password");
  });
});

describe("preflightTrust", () => {
  let corp: CertificateAuthority;
  let other: CertificateAuthority;

  beforeAll(async () => {
    const now = new Date("2026-10-15T12:00:00Z");
    corp = await createCa({ commonName: "Corp database CA", now });
    other = await createCa({ commonName: "Corp web CA", now });
  });

  const files = (content: Record<string, string>) => (path: string) => {
    const text = content[path];
    if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return text;
  };

  test("trusts only the first certificate of postgres.external.caBundleFile, the one Prisma in the migrate job trusts", () => {
    const external = { ...EXTERNAL, caBundleFile: "/etc/pki/corp-db.pem" };
    const trust = preflightTrust(external, files({ "/etc/pki/corp-db.pem": `${corp.certPem}${other.certPem}` }));
    if (!("pem" in trust)) throw new Error(trust.problem);
    expect(trust.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
    expect(new X509Certificate(trust.pem).fingerprint256).toBe(new X509Certificate(corp.certPem).fingerprint256);
  });

  test("names a missing setting, an unreadable file and a file without a certificate", () => {
    expect(preflightTrust(EXTERNAL, files({}))).toEqual({
      problem:
        "postgres.external.caBundleFile is not set, so the certificate of the external PostgreSQL server " +
        "pg.corp.example:5432 cannot be verified with sslmode=verify-full: set it to the CA that issued that certificate",
    });
    const external = { ...EXTERNAL, caBundleFile: "/etc/pki/corp-db.pem" };
    expect(preflightTrust(external, files({}))).toEqual({
      problem:
        "cannot read postgres.external.caBundleFile /etc/pki/corp-db.pem: ENOENT: no such file or directory, open " +
        "'/etc/pki/corp-db.pem'",
    });
    expect(preflightTrust(external, files({ "/etc/pki/corp-db.pem": "" }))).toEqual({
      problem: "postgres.external.caBundleFile /etc/pki/corp-db.pem: no PEM certificate found",
    });
    expect(() => preflightTrust(external, () => {
      throw "not an error";
    })).not.toThrow();
  });
});

const ADMIN: PsqlLogin = { host: "pg.corp.example", port: 5432, database: "postgres", user: "corp_dba", password: "x" };

/** A server that answers the observation with the facts and the clock with `clockMs`, or fails the connection. */
function target(
  answer: { facts?: PostgresFacts; clockMs?: number; connection?: PsqlResult },
  provisioning: "installer" | "manual" = "installer",
): ExternalPostgresTarget {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const runner = fakeRunner((_login, script) => {
    if (answer.connection !== undefined) return answer.connection;
    if (script.includes("clock_timestamp()")) {
      return { exitCode: 0, stdout: `libredb-result clock ${answer.clockMs ?? now}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: observationOutput(answer.facts ?? freshFacts()), stderr: "" };
  });
  return { runner, login: ADMIN, provisioning, budget: { managedKeycloak: true, ...V1_REPLICAS }, now: () => now };
}

describe("externalPostgresProblems", () => {
  test("a fresh PostgreSQL 18 with an admin role that holds CREATEROLE and CREATEDB passes", async () => {
    expect(await externalPostgresProblems(target({ facts: freshFacts({ backup: false }) }))).toEqual([]);
    await checkExternalPostgres(target({ facts: convergedFacts() }));
  });

  test("names the admin attribute, the standby, the budget and the clock skew at once", async () => {
    const facts = freshFacts({ backup: false });
    const problems = await externalPostgresProblems(
      target({
        facts: {
          ...facts,
          server: { ...facts.server, inRecovery: true, maxConnections: 50 },
          admin: { ...facts.admin, name: "corp_dba", createRole: false },
        },
        clockMs: Date.parse("2026-10-15T12:00:16Z"),
      }),
    );
    expect(problems).toEqual([
      "the server is a standby (pg_is_in_recovery() is true), and the installation needs the primary",
      "max_connections is 50, below the connection budget of 62: 3 reserved + 20 for the Keycloak pool + " +
        "1 Platform replica x 14 + 1 Studio replica x 10 + 15",
      "the admin role corp_dba lacks CREATEROLE, and provisioning needs SUPERUSER, or CREATEROLE and CREATEDB",
      "the PostgreSQL clock reads 2026-10-15T12:00:16.000Z and the installer clock 2026-10-15T12:00:00.000Z, 16.0 s " +
        "apart, and the limit is 15 s",
    ]);
  });

  test("with provisioning manual it logs in as an app role, whose attributes it does not check", async () => {
    const facts = freshFacts({ backup: false });
    const app = { ...facts, admin: { ...facts.admin, name: "libredb_platform", createRole: false, createDb: false } };
    expect(await externalPostgresProblems(target({ facts: app }, "manual"))).toEqual([]);
  });

  test("a certificate that does not verify names the server, the role and caBundleFile", async () => {
    const stderr =
      'psql: error: connection to server at "pg.corp.example" (10.0.0.5), port 5432 failed: SSL error: certificate verify failed\n';
    const connection = { exitCode: 2, stdout: "", stderr };
    expect(await externalPostgresProblems(target({ connection }))).toEqual([
      "cannot connect to the external PostgreSQL server pg.corp.example:5432 as corp_dba with sslmode=verify-full: " +
        'connection to server at "pg.corp.example" (10.0.0.5), port 5432 failed: SSL error: certificate verify failed; ' +
        "the first certificate of postgres.external.caBundleFile must be the CA that issued the server certificate",
    ]);
    const refused = { exitCode: 2, stdout: "", stderr: "psql: error: password authentication failed\n" };
    expect(await externalPostgresProblems(target({ connection: refused }, "manual"))).toEqual([
      "cannot connect to the external PostgreSQL server pg.corp.example:5432 as corp_dba with sslmode=verify-full: " +
        "password authentication failed; with provisioning manual, a DBA runs the script of 'libredb-installer " +
        "db-script' first",
    ]);
    const error = await checkExternalPostgres(target({ connection })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreflightError);
    expect((error as PreflightError).exitCode).toBe(3);
  });

  test("names a server older than PostgreSQL 15, and lets any other psql failure through", async () => {
    const old = freshFacts().server;
    const connection = {
      exitCode: 3,
      stdout: `libredb-result server ${JSON.stringify({ ...old, version: "14.24", versionNum: 140024 })}\n`,
      stderr: "ERROR: unrecognized configuration parameter",
    };
    expect(await externalPostgresProblems(target({ connection }))).toEqual([
      "the server runs PostgreSQL 14.24, and LibreDB needs 15 or newer",
    ]);
    const broken = { exitCode: 3, stdout: "", stderr: "ERROR: permission denied" };
    await expect(externalPostgresProblems(target({ connection: broken }))).rejects.toThrow("permission denied");
  });
});

function config(postgres?: Record<string, unknown>): DockerInstallation {
  const parsed = parseInstallation({
    apiVersion: "install.libredb.org/v1",
    kind: "LibreDBInstallation",
    metadata: { name: "acme" },
    mode: "docker",
    endpoints: { hosts: { platform: "platform.corp", studio: "studio.corp", auth: "auth.corp" } },
    ...(postgres === undefined ? {} : { postgres }),
    platform: { organizationName: "Acme", licenseFile: "/etc/libredb/platform.license" },
  });
  if (parsed.mode !== "docker") throw new Error("unreachable");
  return parsed;
}

function context(installation: DockerInstallation, warnings: string[] = []): DockerContext {
  const manifest = manifestFixture();
  return {
    config: installation,
    manifest,
    desired: computeDesired(installation, manifest),
    warn: (message: string) => warnings.push(message),
  } as unknown as DockerContext;
}

const HOST: PreflightObservation = {
  platform: "linux",
  uid: 0,
  dockerEngine: { found: true, version: "27.3.1" },
  compose: { found: true, version: "2.29.7" },
  missingTools: [],
  ports: [],
  externalTls: undefined,
  externalKeycloak: undefined,
};

describe("preflightStep", () => {
  const external = { mode: "external", external: { host: "pg.corp.example", adminUser: "corp_dba", adminPasswordEnv: "PG" } };

  test("a managed PostgreSQL keeps the inputs of the host checks, so an existing install sees no change", () => {
    const managed = context(config());
    expect(hashInputs(preflightStep.inputs(managed))).toBe(hashInputs(preflightDockerStep.inputs(managed)));
    const withExternal = preflightStep.inputs(context(config(external))) as { postgres: unknown };
    expect(withExternal.postgres).toEqual({
      host: "pg.corp.example",
      port: 5432,
      provisioning: "installer",
      adminUser: "corp_dba",
      caBundleFile: null,
    });
    const withCa = { mode: "external", external: { ...external.external, caBundleFile: "/nonexistent/corp-db.pem" } };
    expect((preflightStep.inputs(context(config(withCa))) as { postgres: { caBundleFile: unknown } }).postgres.caBundleFile).toEqual({
      path: "/nonexistent/corp-db.pem",
      sha256: null,
    });
  });

  test("names the host problems and the PostgreSQL problems in one PreflightError", async () => {
    const run = { context: context(config(external)), state: emptyState(), inputHash: "a".repeat(64) };
    const error = await Promise.resolve()
      .then(() => preflightStep.plan({ host: { ...HOST, uid: 1000 }, postgres: { problems: ["the server is a standby"] } }, run))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreflightError);
    expect((error as PreflightError).problems).toEqual([
      "the installer must run as root, and it runs as uid 1000",
      "the server is a standby",
    ]);
  });

  test("records the note of skipped checks as a warning and passes", async () => {
    const warnings: string[] = [];
    const run = { context: context(config(external), warnings), state: emptyState(), inputHash: "a".repeat(64) };
    expect(await preflightStep.plan({ host: HOST, postgres: { note: "the PostgreSQL checks of preflight were skipped" } }, run)).toEqual(
      [],
    );
    expect(await preflightStep.plan({ host: HOST }, run)).toEqual([]);
    expect(warnings).toEqual(["the PostgreSQL checks of preflight were skipped"]);
    expect(() => preflightStep.apply([], run)).toThrow("the preflight step plans no action");
  });
});
