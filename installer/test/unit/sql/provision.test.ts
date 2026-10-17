import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateSecret } from "../../../src/secrets/generate";
import { scramSha256Verifier } from "../../../src/secrets/scram";
import { V1_REPLICAS } from "../../../src/sql/checks";
import { evaluateMatrix, type PostgresFacts } from "../../../src/sql/matrix";
import {
  APP_ROLES,
  backupWarning,
  existingObjects,
  OwnershipConflictError,
  ownershipRecords,
  ManualProvisionError,
  planProvision,
  renderDbaScript,
  renderProvisionScript,
  roleSecretNames,
  roleVerifiers,
  ROLE_SPECS,
  type AppRole,
  type ProvisionInput,
} from "../../../src/sql/provision";
import { quoteIdent, quoteLiteral, quotePsqlArgument } from "../../../src/sql/quote";
import type { OwnershipRecord } from "../../../src/state/store";
import { convergedFacts, freshFacts } from "./fixture";

const golden = join(import.meta.dir, "..", "..", "golden", "provision-managed-keycloak.sql");

// Verifiers with recognisable salts, so the golden script is stable.
function fixedVerifiers(): Record<AppRole, string> {
  return Object.fromEntries(
    APP_ROLES.map((role, index) => [role, scramSha256Verifier(`password-of-${role}`, new Uint8Array(16).fill(index + 1))]),
  ) as Record<AppRole, string>;
}

/** Reads the SQL token at the start of `text`: a double-quoted identifier, or a standard or E'' string literal. */
function readSqlToken(text: string): { value: string; length: number } {
  if (text.startsWith('"')) {
    let value = "";
    for (let at = 1; at < text.length; at += 1) {
      if (text[at] !== '"') value += text[at];
      else if (text[at + 1] === '"') (value += '"'), (at += 1);
      else return { value, length: at + 1 };
    }
    throw new Error("unterminated identifier");
  }
  const escapes = text.startsWith("E'");
  if (!escapes && !text.startsWith("'")) throw new Error(`not a quoted token: ${text}`);
  let value = "";
  for (let at = escapes ? 2 : 1; at < text.length; at += 1) {
    if (escapes && text[at] === "\\") (value += text[at + 1]), (at += 1);
    else if (text[at] !== "'") value += text[at];
    else if (text[at + 1] === "'") (value += "'"), (at += 1);
    else return { value, length: at + 1 };
  }
  throw new Error("unterminated literal");
}

/** Reads a single-quoted psql meta-command argument the way psql does: '' is a quote, and a backslash escapes. */
function readPsqlArgument(text: string): { value: string; length: number } {
  if (!text.startsWith("'")) throw new Error(`not a quoted argument: ${text}`);
  let value = "";
  for (let at = 1; at < text.length; at += 1) {
    if (text[at] === "\\") (value += text[at + 1]), (at += 1);
    else if (text[at] !== "'") value += text[at];
    else if (text[at + 1] === "'") (value += "'"), (at += 1);
    else return { value, length: at + 1 };
  }
  throw new Error("unterminated argument");
}

const TRICKY = [
  "libredb_owner",
  'a"b',
  "it's",
  "back\\slash",
  "both \"quotes' and \\ backslash\\",
  "'; DROP ROLE postgres; --",
  '"; DROP ROLE postgres; --',
  "trailing quote'",
  "trailing backslash\\",
];

describe("quoting", () => {
  test("identifiers and literals with quotes and backslashes are quoted so each stays one token", () => {
    for (const value of TRICKY) {
      for (const [quote, read] of [
        [quoteIdent, readSqlToken],
        [quoteLiteral, readSqlToken],
        [quotePsqlArgument, readPsqlArgument],
      ] as const) {
        const quoted = quote(value);
        // Text after the token must stay outside it, so a value can never end its token early.
        expect({ value, quoted, token: read(`${quoted} AND more`) }).toEqual({
          value,
          quoted,
          token: { value, length: quoted.length },
        });
      }
    }
    expect(quoteLiteral("back\\slash")).toBe("E'back\\\\slash'");
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  test("refuses what cannot be quoted: an empty identifier, a NUL, and a line break in a psql argument", () => {
    expect(() => quoteIdent("")).toThrow("an SQL identifier must not be empty");
    expect(() => quoteIdent("a\0b")).toThrow("an SQL identifier must not contain a NUL character");
    expect(() => quoteLiteral("a\0b")).toThrow("an SQL literal must not contain a NUL character");
    expect(() => quotePsqlArgument("a\nb")).toThrow("a psql argument must not contain a NUL character or a line break");
  });
});

describe("renderProvisionScript", () => {
  test("the rendered script contains SCRAM-SHA-256 verifiers and no generated cleartext password", () => {
    const passwords = Object.fromEntries(APP_ROLES.map((role) => [role, generateSecret()])) as Record<AppRole, string>;
    const verifiers = roleVerifiers(passwords);
    const script = renderProvisionScript({ verifiers, managedKeycloak: true, resetPasswords: ["platform"] });
    const salts = new Set<string>();
    for (const role of APP_ROLES) {
      const verifier = verifiers[role];
      const match = /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.exec(verifier ?? "");
      if (verifier === undefined || match?.[1] === undefined) throw new Error(`no verifier for ${role}`);
      const salt = Buffer.from(match[1], "base64");
      expect(salt).toHaveLength(16);
      salts.add(match[1]);
      // The verifier is the one PostgreSQL derives from the stored password.
      expect(scramSha256Verifier(passwords[role], salt)).toBe(verifier);
      expect(script).toContain(`\\set ${role}_pw '${verifier}'\n`);
      expect(script).not.toContain(passwords[role]);
    }
    expect(salts.size).toBe(APP_ROLES.length);
    expect(script).toContain(`ALTER ROLE "libredb_platform" PASSWORD :'platform_pw';`);
    expect(script.match(/ PASSWORD :'/g)).toHaveLength(1);
  });

  test("renders the PostgreSQL bootstrap with existence guards, owner-only statements under SET ROLE and guarded role settings, equal to test/golden/provision-managed-keycloak.sql", () => {
    const script = renderProvisionScript({
      verifiers: fixedVerifiers(),
      managedKeycloak: true,
      resetPasswords: ["platform"],
    });
    expect(script).toBe(readFileSync(golden, "utf8"));
  });

  test("repairs a drifted role naming only the drifted attributes, which an admin with CREATEROLE may change", () => {
    const script = renderProvisionScript({ verifiers: fixedVerifiers(), managedKeycloak: true, resetPasswords: [] });
    const repair = script.split("\n").find((line) => line.startsWith("SELECT format('ALTER ROLE %I', rolname)"));
    expect(repair).toBe(
      "SELECT format('ALTER ROLE %I', rolname) || CASE WHEN NOT rolcanlogin THEN ' LOGIN' ELSE '' END || " +
        "CASE WHEN rolsuper THEN ' NOSUPERUSER' ELSE '' END || CASE WHEN rolcreatedb THEN ' NOCREATEDB' ELSE '' END || " +
        "CASE WHEN rolcreaterole THEN ' NOCREATEROLE' ELSE '' END || CASE WHEN rolreplication THEN ' NOREPLICATION' ELSE '' END || " +
        "CASE WHEN rolbypassrls THEN ' NOBYPASSRLS' ELSE '' END || CASE WHEN rolconnlimit <> 5 THEN ' CONNECTION LIMIT 5' ELSE '' END " +
        "FROM pg_catalog.pg_roles",
    );
    // A fixed ALTER ROLE ... NOSUPERUSER would need a superuser even where the role is no superuser.
    expect(script).not.toContain("'ALTER ROLE %I LOGIN");
  });

  test("leaves out libredb_keycloak and database keycloak for an external Keycloak", () => {
    const { keycloak: _unused, ...verifiers } = fixedVerifiers();
    const script = renderProvisionScript({ verifiers, managedKeycloak: false, resetPasswords: [] });
    expect(script).not.toContain("keycloak");
    expect(script).not.toContain(" PASSWORD :'");
    expect(script).toContain('GRANT "libredb_owner", "libredb_studio" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;');
  });

  test("refuses to render without the verifier of a role it creates", () => {
    const { studio: _unused, ...verifiers } = fixedVerifiers();
    expect(() => renderProvisionScript({ verifiers, managedKeycloak: true, resetPasswords: [] })).toThrow(
      "no SCRAM verifier for role libredb_studio",
    );
  });

  test("roleVerifiers gives every role a fresh 16-byte salt", () => {
    const salts: Uint8Array[] = [];
    const verifiers = roleVerifiers({ owner: "same-password", studio: "same-password" }, () => {
      const salt = new Uint8Array(16).fill(salts.length + 7);
      salts.push(salt);
      return salt;
    });
    expect(Object.keys(verifiers)).toEqual(["owner", "studio"]);
    expect(verifiers.owner).not.toBe(verifiers.studio);
    expect(salts).toHaveLength(2);
  });
});

describe("renderDbaScript", () => {
  /** The verifier the script sets for a role, and the salt it was derived with. */
  function verifierOf(script: string, role: AppRole): { verifier: string; salt: Buffer } {
    const match = new RegExp(`^\\\\set ${role}_pw '(SCRAM-SHA-256\\$4096:([A-Za-z0-9+/=]+)\\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+)'$`, "m").exec(
      script,
    );
    if (match?.[1] === undefined || match[2] === undefined) throw new Error(`the script sets no verifier for ${role}`);
    return { verifier: match[1], salt: Buffer.from(match[2], "base64") };
  }

  test("the DBA script that db-script writes carries SCRAM verifiers and no cleartext password", () => {
    const passwords = Object.fromEntries(APP_ROLES.map((role) => [role, generateSecret()])) as Record<AppRole, string>;
    const script = renderDbaScript({ passwords, managedKeycloak: true, server: { host: "pg.corp.example", port: 5433 } });
    for (const role of APP_ROLES) {
      expect(script).not.toContain(passwords[role]);
      const { verifier, salt } = verifierOf(script, role);
      expect(salt).toHaveLength(16);
      // The verifier is the one PostgreSQL derives from the password the installer stored.
      expect(scramSha256Verifier(passwords[role], salt)).toBe(verifier);
    }
    // A DBA run sets the password of every role the apps log in as, so running it again converges a role an earlier
    // run created with another password; the backup role keeps the one it was created with.
    for (const role of ["owner", "platform", "studio", "keycloak"] as const) {
      expect(script).toContain(`ALTER ROLE ${quoteIdent(ROLE_SPECS[role].name)} PASSWORD :'${role}_pw';`);
    }
    expect(script).not.toContain(`ALTER ROLE "libredb_backup" PASSWORD`);
    expect(script.split("\n").slice(0, 3)).toEqual([
      "-- LibreDB provisioning of the external PostgreSQL server pg.corp.example:5433, written by libredb-installer db-script.",
      "-- Run it once with psql as a superuser or as a role with CREATEROLE and CREATEDB, such as:",
      '--   psql "host=pg.corp.example port=5433 dbname=postgres user=<admin> sslmode=verify-full sslrootcert=<CA file>" -f <this file>',
    ]);
    // The provisioning script of the bootstrap follows, the one apply runs itself with provisioning installer.
    expect(script).toContain("\n-- Rendered by libredb-installer: Platform's PostgreSQL bootstrap, run as the admin role.\n");
  });

  test("leaves out libredb_keycloak for an external Keycloak and gives each role a fresh salt", () => {
    const { keycloak: _unused, ...passwords } = Object.fromEntries(
      APP_ROLES.map((role) => [role, "same-password"]),
    ) as Record<AppRole, string>;
    const script = renderDbaScript({ passwords, managedKeycloak: false, server: { host: "10.0.0.5", port: 5432 } });
    expect(script).not.toContain("keycloak");
    const salts = (["owner", "platform", "studio", "backup"] as const).map((role) => verifierOf(script, role).salt.toString("hex"));
    expect(new Set(salts).size).toBe(4);
    expect(() => renderDbaScript({ passwords: { owner: "x" }, managedKeycloak: false, server: { host: "db", port: 5432 } })).toThrow(
      "no stored password for role libredb_platform",
    );
  });
});

describe("ManualProvisionError", () => {
  test("names the server and every problem, exits 3 and tells how a DBA provisions the server", () => {
    const error = new ManualProvisionError({ host: "pg.corp.example", port: 5432 }, [
      "libredb_studio does not log in with the password the installer stored",
      "libredb_owner has connection limit 5",
    ]);
    expect(error.exitCode).toBe(3);
    expect(error.problems).toHaveLength(2);
    expect(error.message).toBe(
      [
        "the external PostgreSQL server pg.corp.example:5432 is not provisioned as the DBA script of db-script provisions it:",
        "  libredb_studio does not log in with the password the installer stored",
        "  libredb_owner has connection limit 5",
        "Run 'libredb-installer db-script -c <libredb.yaml> -o <file>', have a DBA run that script with psql as a " +
          "superuser or a role with CREATEROLE and CREATEDB, then apply again.",
      ].join("\n"),
    );
  });
});

function input(facts: PostgresFacts, overrides: Partial<ProvisionInput> = {}): ProvisionInput {
  const expectation = { managedKeycloak: true, backupRole: facts.admin.superuser || facts.admin.grantsReadAllData };
  return {
    facts,
    rows: evaluateMatrix(facts, expectation),
    logins: {},
    ownership: [],
    expectation,
    budget: { managedKeycloak: true, ...V1_REPLICAS },
    ...overrides,
  };
}

const allRecorded = (facts: PostgresFacts): OwnershipRecord[] =>
  ownershipRecords(existingObjects(facts, { managedKeycloak: true, backupRole: true }));

describe("planProvision", () => {
  test("a fresh server plans every role, both databases and the privileges of the PostgreSQL bootstrap", () => {
    expect(planProvision(input(freshFacts())).map((action) => action.summary)).toEqual([
      "create role libredb_owner",
      "create role libredb_platform",
      "create role libredb_studio",
      "create role libredb_keycloak",
      "create role libredb_backup",
      "create database libredb",
      "create database keycloak",
      "grant the privileges and set the schema and role settings of Platform's PostgreSQL bootstrap",
    ]);
  });

  test("a converged server whose roles log in with their stored passwords plans nothing", () => {
    const facts = convergedFacts();
    const logins = Object.fromEntries(APP_ROLES.map((role) => [role, true]));
    expect(planProvision(input(facts, { logins, ownership: allRecorded(facts) }))).toEqual([]);
  });

  test("sets the password only of a role that fails to log in with its stored password", () => {
    const facts = convergedFacts();
    const logins = { ...Object.fromEntries(APP_ROLES.map((role) => [role, true])), studio: false };
    expect(planProvision(input(facts, { logins, ownership: allRecorded(facts) }))).toEqual([
      {
        kind: "password",
        role: "studio",
        summary: "set the password of role libredb_studio, which does not log in with the stored one",
      },
    ]);
  });

  test("names the false rows of a drifted install", () => {
    const facts = convergedFacts();
    const drifted = { ...facts, roles: facts.roles.map((role) => (role.name === "libredb_owner" ? { ...role, connectionLimit: 9 } : role)) };
    const logins = Object.fromEntries(APP_ROLES.map((role) => [role, true]));
    expect(planProvision(input(drifted, { logins, ownership: allRecorded(facts) }))).toEqual([
      {
        kind: "converge",
        rows: ["libredb_owner has connection limit 5"],
        summary: "converge Platform's PostgreSQL bootstrap, where these rows are false: libredb_owner has connection limit 5",
      },
    ]);
  });

  test("a role or database that exists but is not recorded in the state stops the step with exit 3 naming it", () => {
    const facts = convergedFacts();
    const ownership = allRecorded(facts).filter(
      (record) => record.name !== "libredb_studio" && record.name !== "keycloak",
    );
    let error: unknown;
    try {
      planProvision(input(facts, { ownership }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OwnershipConflictError);
    expect((error as OwnershipConflictError).exitCode).toBe(3);
    expect((error as OwnershipConflictError).message).toBe(
      "role libredb_studio and database keycloak exist on the PostgreSQL server, but this installation did not " +
        "create them; drop or rename them, because the installer never adopts objects it did not create",
    );
  });

  test("a record of another kind or step does not count as created by provisioning", () => {
    const facts = convergedFacts();
    const ownership: OwnershipRecord[] = allRecorded(facts).map((record) =>
      record.name === "libredb" ? { ...record, kind: "docker-network" } : record,
    );
    expect(() => planProvision(input(facts, { ownership }))).toThrow("database libredb exist");
  });

  test("an admin role that can provision neither as a superuser nor with CREATEROLE and CREATEDB stops planning with exit 3", () => {
    const facts = freshFacts({ backup: false });
    const weak = { ...facts, admin: { ...facts.admin, name: "dba", createDb: false } };
    expect(() => planProvision(input(weak))).toThrow(
      "the admin role dba lacks CREATEDB, and provisioning needs SUPERUSER, or CREATEROLE and CREATEDB",
    );
  });

  test("the server checks run first, so an old server fails with exit 3 before anything else", () => {
    const facts = { ...freshFacts(), server: { ...freshFacts().server, version: "14.24", versionNum: 140024 } };
    expect(() => planProvision(input(facts))).toThrow("the server runs PostgreSQL 14.24, and LibreDB needs 15 or newer");
  });
});

describe("ownership and secrets", () => {
  test("records each existing object as created by postgres-provision", () => {
    expect(existingObjects(convergedFacts({ managedKeycloak: false, backup: false }), { managedKeycloak: false, backupRole: false })).toEqual([
      { kind: "postgres-role", name: "libredb_owner" },
      { kind: "postgres-role", name: "libredb_platform" },
      { kind: "postgres-role", name: "libredb_studio" },
      { kind: "postgres-database", name: "libredb" },
    ]);
    expect(ownershipRecords([{ kind: "postgres-database", name: "libredb" }])).toEqual([
      { kind: "postgres-database", name: "libredb", step: "postgres-provision" },
    ]);
  });

  test("names one generated password secret per role, the Keycloak one only for a managed Keycloak", () => {
    expect(roleSecretNames(true)).toEqual([
      "postgres-owner-password",
      "postgres-platform-password",
      "postgres-studio-password",
      "postgres-keycloak-password",
      "postgres-backup-password",
    ]);
    expect(roleSecretNames(false)).not.toContain("postgres-keycloak-password");
    expect(ROLE_SPECS.keycloak).toEqual({
      name: "libredb_keycloak",
      connectionLimit: 25,
      secret: "postgres-keycloak-password",
      database: "keycloak",
    });
  });

  test("warns about the backup role only when the admin cannot grant pg_read_all_data", () => {
    const admin = freshFacts().admin;
    expect(backupWarning({ ...admin, superuser: true })).toBeUndefined();
    expect(backupWarning({ ...admin, superuser: false, grantsReadAllData: true })).toBeUndefined();
    expect(backupWarning({ ...admin, name: "dba", superuser: false, grantsReadAllData: false })).toBe(
      "role libredb_backup was not created, because the admin role dba is neither a superuser nor holds " +
        "pg_read_all_data WITH ADMIN OPTION; grant it that option and apply again to get a backup role for " +
        "customer-run backups",
    );
  });
});
