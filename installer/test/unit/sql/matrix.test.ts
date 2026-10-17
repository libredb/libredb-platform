import { describe, expect, test } from "bun:test";
import { PostgresCheckError } from "../../../src/sql/checks";
import {
  appRoleExpectation,
  evaluateMatrix,
  falseRows,
  matrixExpectation,
  MatrixError,
  observationScript,
  observePostgres,
  parseObservation,
  postgresPrivilegesCheck,
  requireMatrix,
  type PostgresFacts,
} from "../../../src/sql/matrix";
import { SqlError } from "../../../src/sql/runner";
import { ADMIN_LOGIN, convergedFacts, fakeRunner, freshFacts, observationOutput } from "./fixture";

const expect_ = { managedKeycloak: true, backupRole: true };

function rowsOf(facts: PostgresFacts, expectation = expect_) {
  return evaluateMatrix(facts, expectation);
}

function withRole(facts: PostgresFacts, name: string, change: Record<string, unknown>): PostgresFacts {
  return { ...facts, roles: facts.roles.map((role) => (role.name === name ? { ...role, ...change } : role)) };
}

describe("privilege matrix", () => {
  test("the matrix fails the row libredb_platform has no USAGE on schema studio when has_schema_privilege answers true", () => {
    const facts = convergedFacts();
    const studio = facts.schemas?.studio;
    if (studio === undefined) throw new Error("the fixture has no schema studio");
    const drifted: PostgresFacts = {
      ...facts,
      schemas: { ...facts.schemas, studio: { ...studio, usage: { ...studio.usage, libredb_platform: true } } },
    };
    expect(falseRows(rowsOf(facts))).toEqual([]);
    expect(falseRows(rowsOf(drifted))).toEqual(["libredb_platform has no USAGE on schema studio"]);
  });

  test("lists every row of the privilege matrix for a managed Keycloak and a backup role", () => {
    expect(rowsOf(convergedFacts()).map((row) => row.row)).toEqual([
      "role libredb_owner exists and can log in",
      "libredb_owner has no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS",
      "libredb_owner has connection limit 5",
      "role libredb_platform exists and can log in",
      "libredb_platform has no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS",
      "libredb_platform has connection limit 25",
      "role libredb_studio exists and can log in",
      "libredb_studio has no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS",
      "libredb_studio has connection limit 30",
      "role libredb_keycloak exists and can log in",
      "libredb_keycloak has no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS",
      "libredb_keycloak has connection limit 25",
      "database libredb is owned by libredb_owner",
      "database libredb has encoding UTF8",
      "PUBLIC has no privilege on database libredb",
      "libredb_owner has CONNECT on database libredb",
      "libredb_platform has CONNECT on database libredb",
      "libredb_studio has CONNECT on database libredb",
      "libredb_platform has no CREATE on database libredb",
      "libredb_studio has no CREATE on database libredb",
      "libredb_keycloak has no CONNECT on database libredb",
      "PUBLIC has no privilege on schema public",
      "schema studio is owned by libredb_studio",
      "libredb_platform has no USAGE on schema studio",
      "libredb_owner has search_path=platform in database libredb",
      "libredb_platform has search_path=platform in database libredb",
      "libredb_studio has search_path=studio in database libredb",
      "libredb_studio has statement_timeout=30s in database libredb",
      "libredb_studio has idle_in_transaction_session_timeout=60s in database libredb",
      "libredb_platform has idle_in_transaction_session_timeout=60s in database libredb",
      "libredb_studio has no idle_session_timeout",
      "database keycloak is owned by libredb_keycloak",
      "PUBLIC has no privilege on database keycloak",
      "role libredb_backup exists and can log in",
      "libredb_backup has no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS",
      "libredb_backup reads all data through pg_read_all_data",
      "libredb_backup has CONNECT on database libredb",
      "libredb_backup has CONNECT on database keycloak",
    ]);
  });

  test("leaves out the Keycloak rows for an external Keycloak and the backup rows when the admin cannot grant", () => {
    const facts = convergedFacts({ managedKeycloak: false, backup: false });
    const rows = rowsOf(facts, { managedKeycloak: false, backupRole: false });
    expect(falseRows(rows)).toEqual([]);
    expect(rows.some((row) => row.row.includes("keycloak"))).toBe(false);
    expect(rows.some((row) => row.row.includes("libredb_backup"))).toBe(false);
  });

  test("a fresh server fails every row", () => {
    expect(rowsOf(freshFacts()).every((row) => !row.ok)).toBe(true);
  });

  test("fails the attribute, connection limit, settings and idle_session_timeout rows of a drifted role", () => {
    let facts = withRole(convergedFacts(), "libredb_studio", {
      createRole: true,
      connectionLimit: 100,
      databaseSettings: ["search_path=studio", "idle_session_timeout=5min"],
    });
    facts = withRole(facts, "libredb_owner", { login: false, roleSettings: [] });
    facts = withRole(facts, "libredb_platform", { roleSettings: ["idle_session_timeout=1min"] });
    expect(falseRows(rowsOf(facts))).toEqual([
      "role libredb_owner exists and can log in",
      "libredb_studio has no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS",
      "libredb_studio has connection limit 30",
      "libredb_studio has statement_timeout=30s in database libredb",
      "libredb_studio has idle_in_transaction_session_timeout=60s in database libredb",
      "libredb_studio has no idle_session_timeout",
    ]);
    expect(
      falseRows(rowsOf(withRole(convergedFacts(), "libredb_studio", { roleSettings: ["idle_session_timeout=5min"] }))),
    ).toEqual(["libredb_studio has no idle_session_timeout"]);
  });

  test("fails the database and schema rows of drifted privileges and owners", () => {
    const facts = convergedFacts();
    const [libredb, keycloak] = facts.databases;
    if (libredb === undefined || keycloak === undefined || facts.schemas === null) throw new Error("incomplete fixture");
    const drifted: PostgresFacts = {
      ...facts,
      databases: [
        {
          ...libredb,
          encoding: "SQL_ASCII",
          publicPrivileges: ["CONNECT", "TEMPORARY"],
          connect: { ...libredb.connect, libredb_keycloak: true, libredb_studio: false },
          create: { ...libredb.create, libredb_studio: true },
        },
        { ...keycloak, owner: "postgres", publicPrivileges: ["CONNECT"] },
      ],
      schemas: {
        public: { ...facts.schemas.public!, publicPrivileges: ["USAGE"] },
        studio: { ...facts.schemas.studio!, owner: "libredb_owner" },
      },
    };
    expect(falseRows(rowsOf(drifted))).toEqual([
      "database libredb has encoding UTF8",
      "PUBLIC has no privilege on database libredb",
      "libredb_studio has CONNECT on database libredb",
      "libredb_studio has no CREATE on database libredb",
      "libredb_keycloak has no CONNECT on database libredb",
      "PUBLIC has no privilege on schema public",
      "schema studio is owned by libredb_studio",
      "database keycloak is owned by libredb_keycloak",
      "PUBLIC has no privilege on database keycloak",
    ]);
  });

  test("fails the schema rows when database libredb has no schema public or studio", () => {
    const facts = { ...convergedFacts(), schemas: {} };
    expect(falseRows(rowsOf(facts))).toEqual([
      "PUBLIC has no privilege on schema public",
      "schema studio is owned by libredb_studio",
      "libredb_platform has no USAGE on schema studio",
    ]);
  });

  test("fails the backup rows of a backup role that cannot read all data", () => {
    const facts = withRole(convergedFacts(), "libredb_backup", { readsAllData: false });
    expect(falseRows(rowsOf(facts))).toEqual(["libredb_backup reads all data through pg_read_all_data"]);
  });

  test("expects the backup role when the admin is a superuser or holds pg_read_all_data WITH ADMIN OPTION", () => {
    const admin = freshFacts().admin;
    expect(matrixExpectation({ ...admin, superuser: true, grantsReadAllData: false }, true)).toEqual(expect_);
    expect(matrixExpectation({ ...admin, superuser: false, grantsReadAllData: true }, false).backupRole).toBe(true);
    expect(matrixExpectation({ ...admin, superuser: false, grantsReadAllData: false }, true).backupRole).toBe(false);
  });

  test("requireMatrix throws exit 4 naming every false row", () => {
    expect(() => requireMatrix(rowsOf(convergedFacts()))).not.toThrow();
    const facts = withRole(convergedFacts(), "libredb_owner", { connectionLimit: 7 });
    let error: unknown;
    try {
      requireMatrix(rowsOf(facts));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MatrixError);
    expect((error as MatrixError).exitCode).toBe(4);
    expect((error as MatrixError).message).toBe(
      "the PostgreSQL privilege matrix has false rows:\n  libredb_owner has connection limit 5",
    );
  });
});

describe("observation", () => {
  test("the script reports the server, the cluster and, when the admin can connect, the schemas of libredb", () => {
    const script = observationScript();
    expect(script).toContain("SELECT 'libredb-result server ' || ");
    expect(script).toContain("SELECT 'libredb-result cluster ' || ");
    expect(script).toContain("AS libredb_connect \\gset\n\\if :libredb_connect\n\\connect 'libredb'\n");
    expect(script).toContain("'MEMBER WITH ADMIN OPTION'");
    expect(script).toContain("has_schema_privilege(r.oid, n.oid, 'USAGE')");
  });

  test("parses the facts psql printed for a converged and for a fresh server", async () => {
    for (const facts of [convergedFacts(), freshFacts()]) {
      const runner = fakeRunner(() => ({ exitCode: 0, stdout: observationOutput(facts), stderr: "" }));
      expect(await observePostgres(runner, ADMIN_LOGIN)).toEqual(facts);
      expect(runner.runs).toEqual([{ login: ADMIN_LOGIN, script: observationScript() }]);
    }
  });

  test("refuses output without the cluster facts", () => {
    const facts = freshFacts();
    expect(() => parseObservation(`libredb-result server ${JSON.stringify(facts.server)}\n`)).toThrow(
      "the observation of PostgreSQL printed no cluster result",
    );
    expect(() => parseObservation("")).toThrow("the observation of PostgreSQL printed no server result");
    expect(() =>
      parseObservation(observationOutput(facts).replace('"roles":[]', '"roles":[{"name":1}]')),
    ).toThrow("the cluster facts are malformed: roles[0].name");
  });

  test("a failed observation of an old server still names its version with exit 3, and otherwise fails with psql's error", async () => {
    const old = { ...freshFacts().server, version: "13.20", versionNum: 130020 };
    const failing = fakeRunner(() => ({
      exitCode: 3,
      stdout: `libredb-result server ${JSON.stringify(old)}\n`,
      stderr: 'psql:<stdin>:2: ERROR:  role "pg_read_all_data" does not exist\n',
    }));
    const error = await observePostgres(failing, ADMIN_LOGIN).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgresCheckError);
    expect((error as PostgresCheckError).message).toContain("13.20");

    const broken = fakeRunner(() => ({ exitCode: 2, stdout: "", stderr: "psql: error: connection refused\n" }));
    const sqlError = await observePostgres(broken, ADMIN_LOGIN).catch((caught: unknown) => caught);
    expect(sqlError).toBeInstanceOf(SqlError);
    expect((sqlError as SqlError).message).toBe(
      "psql as postgres on postgres:5432/postgres exited with code 2: psql: error: connection refused",
    );
  });
});

describe("postgres-privileges", () => {
  const context = (facts: PostgresFacts, managedKeycloak = true, observer: "admin" | "app-role" = "admin") => ({
    postgres: {
      runner: fakeRunner(() => ({ exitCode: 0, stdout: observationOutput(facts), stderr: "" })),
      admin: ADMIN_LOGIN,
      observer,
      managedKeycloak,
    },
  });

  test("passes on a converged server", async () => {
    expect(postgresPrivilegesCheck.id).toBe("postgres-privileges");
    expect(await postgresPrivilegesCheck.run(context(convergedFacts()))).toEqual({ passed: true });
    expect(
      await postgresPrivilegesCheck.run(context(convergedFacts({ managedKeycloak: false }), false)),
    ).toEqual({ passed: true });
  });

  test("as an app role of an external server, expects the backup rows exactly when the backup role exists", async () => {
    // An app role reads its own attributes where the admin's would be, so they say nothing about pg_read_all_data.
    const asApp = (facts: PostgresFacts): PostgresFacts => ({
      ...facts,
      admin: { name: "libredb_platform", superuser: false, createRole: false, createDb: false, grantsReadAllData: false },
    });
    expect(await postgresPrivilegesCheck.run(context(asApp(convergedFacts()), true, "app-role"))).toEqual({ passed: true });
    expect(appRoleExpectation(asApp(convergedFacts()), true)).toEqual({ managedKeycloak: true, backupRole: true });
    const withoutBackup = asApp(convergedFacts({ backup: false }));
    expect(appRoleExpectation(withoutBackup, false)).toEqual({ managedKeycloak: false, backupRole: false });
    expect(await postgresPrivilegesCheck.run(context(withoutBackup, true, "app-role"))).toEqual({ passed: true });
    const drifted = withRole(asApp(convergedFacts()), "libredb_backup", { readsAllData: false });
    expect(await postgresPrivilegesCheck.run(context(drifted, true, "app-role"))).toEqual({
      passed: false,
      cause: "false rows: libredb_backup reads all data through pg_read_all_data",
    });
  });

  test("fails naming the false rows", async () => {
    const facts = withRole(convergedFacts(), "libredb_platform", { superuser: true });
    expect(await postgresPrivilegesCheck.run(context(facts))).toEqual({
      passed: false,
      cause: "false rows: libredb_platform has no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS",
    });
  });
});
