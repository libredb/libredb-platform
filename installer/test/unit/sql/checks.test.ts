import { describe, expect, test } from "bun:test";
import {
  adminCheckFailures,
  checkAdmin,
  checkNotifyRoundTrip,
  checkServer,
  connectionBudget,
  KEYCLOAK_DB_POOL_MAX_SIZE,
  notifyRoundTripScript,
  parseServerFacts,
  PLATFORM_CONNECTIONS_PER_REPLICA,
  PostgresCheckError,
  serverCheckFailures,
  serverFactsQuery,
  V1_REPLICAS,
  type ServerFacts,
} from "../../../src/sql/checks";
import { freshFacts } from "./fixture";

const server = (overrides: Partial<ServerFacts> = {}): ServerFacts => ({ ...freshFacts().server, ...overrides });

const managed = { managedKeycloak: true, ...V1_REPLICAS };

function refusal(run: () => void): PostgresCheckError {
  try {
    run();
  } catch (error) {
    if (error instanceof PostgresCheckError) return error;
    throw error;
  }
  throw new Error("expected a PostgresCheckError");
}

describe("server checks", () => {
  test("a server with max_connections 50 fails the budget of 62 and names both numbers", () => {
    const facts = server({ maxConnections: 50 });
    expect(connectionBudget(facts, managed).required).toBe(62);
    const error = refusal(() => checkServer(facts, managed));
    expect(error.exitCode).toBe(3);
    expect(error.failures).toEqual([
      "max_connections is 50, below the connection budget of 62: 3 reserved + 20 for the Keycloak pool + " +
        "1 Platform replica x 14 + 1 Studio replica x 10 + 15",
    ]);
    expect(error.message).toContain("50");
    expect(error.message).toContain("62");
  });

  test("the connection budget counts 14 connections per Platform replica", () => {
    // A Platform replica holds Prisma's pool of 10 and a scheduler lock pool of 4 (docs/deploy/platform-runtime.md).
    expect(PLATFORM_CONNECTIONS_PER_REPLICA).toBe(14);
    expect(connectionBudget(server(), managed)).toEqual({
      required: 62,
      terms: "3 reserved + 20 for the Keycloak pool + 1 Platform replica x 14 + 1 Studio replica x 10 + 15",
    });
    const external = { managedKeycloak: false, platformReplicas: 2, studioReplicas: 1 };
    expect(connectionBudget(server(), external)).toEqual({
      required: 56,
      terms: "3 reserved + 2 Platform replicas x 14 + 1 Studio replica x 10 + 15",
    });
    expect(serverCheckFailures(server({ maxConnections: 55 }), external)).toEqual([
      "max_connections is 55, below the connection budget of 56: 3 reserved + 2 Platform replicas x 14 + " +
        "1 Studio replica x 10 + 15",
    ]);
  });

  test("a server reporting pg_is_in_recovery() true fails with exit 3", () => {
    const error = refusal(() => checkServer(server({ inRecovery: true }), managed));
    expect(error.exitCode).toBe(3);
    expect(error.failures).toEqual([
      "the server is a standby (pg_is_in_recovery() is true), and the installation needs the primary",
    ]);
  });

  test("a server older than PostgreSQL 15 fails naming its version", () => {
    const error = refusal(() =>
      checkServer(server({ version: "14.24 (Debian 14.24-1.pgdg13+2)", versionNum: 140024 }), managed),
    );
    expect(error.failures).toEqual(["the server runs PostgreSQL 14.24 (Debian 14.24-1.pgdg13+2), and LibreDB needs 15 or newer"]);
    expect(error.message).toBe(
      "the PostgreSQL server fails the checks of the installation:\n" +
        "  the server runs PostgreSQL 14.24 (Debian 14.24-1.pgdg13+2), and LibreDB needs 15 or newer",
    );
  });

  test("the default max_connections of 100 covers the v1 budget, which counts the Keycloak pool only when Keycloak is managed", () => {
    expect(serverCheckFailures(server(), managed)).toEqual([]);
    expect(connectionBudget(server(), { ...managed, managedKeycloak: false })).toEqual({
      required: 42,
      terms: "3 reserved + 1 Platform replica x 14 + 1 Studio replica x 10 + 15",
    });
    expect(KEYCLOAK_DB_POOL_MAX_SIZE).toBe(20);
  });

  test("reserved counts superuser_reserved_connections plus reserved_connections where the server has it", () => {
    expect(connectionBudget(server({ reservedConnections: 5 }), managed).required).toBe(67);
    expect(connectionBudget(server({ reservedConnections: null }), managed).required).toBe(62);
    const replicas = connectionBudget(server(), { managedKeycloak: true, platformReplicas: 2, studioReplicas: 3 });
    expect(replicas).toEqual({
      required: 96,
      terms: "3 reserved + 20 for the Keycloak pool + 2 Platform replicas x 14 + 3 Studio replicas x 10 + 15",
    });
  });

  test("names every failed check at once", () => {
    const error = refusal(() =>
      checkServer(server({ version: "14.24", versionNum: 140024, inRecovery: true, maxConnections: 20 }), managed),
    );
    expect(error.failures).toHaveLength(3);
  });

  test("the facts query prints one marked line and the parser refuses a malformed answer", () => {
    expect(serverFactsQuery()).toStartWith("SELECT 'libredb-result server ' || ");
    expect(serverFactsQuery()).toContain("current_setting('reserved_connections', true)");
    expect(parseServerFacts(server())).toEqual(server());
    expect(() => parseServerFacts({ ...server(), maxConnections: "100" })).toThrow(
      "the server facts are malformed: maxConnections",
    );
  });
});

describe("admin role checks", () => {
  const admin = { name: "dba", superuser: false, createRole: true, createDb: true };

  test("an admin role without CREATEROLE fails preflight with exit 3 naming the attribute", () => {
    const error = refusal(() => checkAdmin({ ...admin, createRole: false }));
    expect(error.exitCode).toBe(3);
    expect(error.failures).toEqual([
      "the admin role dba lacks CREATEROLE, and provisioning needs SUPERUSER, or CREATEROLE and CREATEDB",
    ]);
    expect(error.message).toContain("CREATEROLE");
  });

  test("names both missing attributes, and passes a superuser or a role with CREATEROLE and CREATEDB", () => {
    expect(adminCheckFailures({ ...admin, createRole: false, createDb: false })).toEqual([
      "the admin role dba lacks CREATEROLE and CREATEDB, and provisioning needs SUPERUSER, or CREATEROLE and CREATEDB",
    ]);
    expect(adminCheckFailures({ ...admin, createDb: false })).toEqual([
      "the admin role dba lacks CREATEDB, and provisioning needs SUPERUSER, or CREATEROLE and CREATEDB",
    ]);
    expect(adminCheckFailures(admin)).toEqual([]);
    expect(adminCheckFailures({ name: "postgres", superuser: true, createRole: false, createDb: false })).toEqual([]);
    expect(() => checkAdmin(admin)).not.toThrow();
  });
});

describe("LISTEN/NOTIFY round trip", () => {
  const login = { host: "postgres", port: 5432, database: "libredb", user: "libredb_studio", password: "x" };

  test("listens and notifies on the installer's own channel with the nonce as payload", () => {
    expect(notifyRoundTripScript("abc123")).toBe(
      'LISTEN "libredb_installer_check";\nNOTIFY "libredb_installer_check", \'abc123\';\n',
    );
  });

  test("passes when psql printed the notification with this run's nonce", () => {
    const stdout =
      'Asynchronous notification "libredb_installer_check" with payload "abc123" received from server process with PID 81.\n';
    expect(() => checkNotifyRoundTrip({ exitCode: 0, stdout, stderr: "" }, "abc123", login)).not.toThrow();
  });

  test("fails with exit 3 naming the role, the host and the port when no notification came back", () => {
    const error = refusal(() =>
      checkNotifyRoundTrip({ exitCode: 0, stdout: "", stderr: "" }, "abc123", login),
    );
    expect(error.exitCode).toBe(3);
    expect(error.failures).toEqual([
      "a LISTEN/NOTIFY round trip as libredb_studio on postgres:5432 received no notification, so LISTEN does not " +
        "work there: Studio needs the primary directly or through a session-mode pooler",
    ]);
  });

  test("fails naming psql's error when psql could not run the round trip", () => {
    const error = refusal(() =>
      checkNotifyRoundTrip({ exitCode: 2, stdout: "", stderr: "psql: error: connection refused\n" }, "abc123", login),
    );
    expect(error.failures).toEqual([
      "a LISTEN/NOTIFY round trip as libredb_studio on postgres:5432 failed: psql exited with code 2: psql: error: connection refused",
    ]);
  });
});
