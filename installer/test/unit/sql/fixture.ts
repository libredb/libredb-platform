// What the observation script reports for a PostgreSQL server: a fresh one, or one that provisioning converged.
import type { PsqlLogin, PsqlResult, SqlRunner } from "../../../src/sql/runner";
import type { PostgresFacts, RoleFacts } from "../../../src/sql/matrix";

export interface FactsOptions {
  /** Whether the installation manages Keycloak, which adds role libredb_keycloak and database keycloak. */
  managedKeycloak?: boolean;
  /** Whether the admin role can grant pg_read_all_data, which adds role libredb_backup. */
  backup?: boolean;
}

const NO_ATTRIBUTES = { superuser: false, createDb: false, createRole: false, replication: false, bypassRls: false };

function role(name: string, connectionLimit: number, databaseSettings: string[] = []): RoleFacts {
  return {
    name,
    login: true,
    ...NO_ATTRIBUTES,
    connectionLimit,
    readsAllData: false,
    databaseSettings,
    roleSettings: [],
  };
}

/** A PostgreSQL 18 server with the default max_connections of 100 and nothing of LibreDB on it. */
export function freshFacts(options: FactsOptions = {}): PostgresFacts {
  const backup = options.backup ?? true;
  return {
    server: {
      version: "18.6 (Debian 18.6-1.pgdg13+2)",
      versionNum: 180006,
      inRecovery: false,
      maxConnections: 100,
      superuserReservedConnections: 3,
      reservedConnections: 0,
    },
    admin: { name: "postgres", superuser: backup, createRole: true, createDb: true, grantsReadAllData: backup },
    roles: [],
    databases: [],
    schemas: null,
  };
}

/** The same server after provisioning: every row of the privilege matrix holds. */
export function convergedFacts(options: FactsOptions = {}): PostgresFacts {
  const managedKeycloak = options.managedKeycloak ?? true;
  const backup = options.backup ?? true;
  const roles = [
    role("libredb_owner", 5, ["search_path=platform"]),
    role("libredb_platform", 25, ["search_path=platform", "idle_in_transaction_session_timeout=60s"]),
    role("libredb_studio", 30, [
      "search_path=studio",
      "statement_timeout=30s",
      "idle_in_transaction_session_timeout=60s",
    ]),
  ];
  if (managedKeycloak) roles.push(role("libredb_keycloak", 25));
  if (backup) roles.push({ ...role("libredb_backup", -1), readsAllData: true });
  const all = roles.map((entry) => entry.name);
  const flags = (granted: readonly string[]) => Object.fromEntries(all.map((name) => [name, granted.includes(name)]));
  const libredbConnect = ["libredb_owner", "libredb_platform", "libredb_studio", ...(backup ? ["libredb_backup"] : [])];
  const databases = [
    {
      name: "libredb",
      owner: "libredb_owner",
      encoding: "UTF8",
      publicPrivileges: [],
      connect: flags(libredbConnect),
      create: flags(["libredb_owner"]),
    },
  ];
  if (managedKeycloak) {
    databases.push({
      name: "keycloak",
      owner: "libredb_keycloak",
      encoding: "UTF8",
      publicPrivileges: [],
      connect: flags(["libredb_keycloak", ...(backup ? ["libredb_backup"] : [])]),
      create: flags(["libredb_keycloak"]),
    });
  }
  return {
    ...freshFacts(options),
    roles,
    databases,
    schemas: {
      public: { owner: "pg_database_owner", publicPrivileges: [], usage: flags(["libredb_owner"]) },
      studio: { owner: "libredb_studio", publicPrivileges: [], usage: flags(["libredb_studio"]) },
    },
  };
}

/** The standard output of the observation script for these facts, as psql prints it in unaligned tuples-only mode. */
export function observationOutput(facts: PostgresFacts): string {
  const lines = [
    `libredb-result server ${JSON.stringify(facts.server)}`,
    `libredb-result cluster ${JSON.stringify({ admin: facts.admin, roles: facts.roles, databases: facts.databases })}`,
  ];
  if (facts.schemas !== null) lines.push(`libredb-result libredb ${JSON.stringify({ schemas: facts.schemas })}`);
  return `${lines.join("\n")}\n`;
}

export interface RecordedRun {
  login: PsqlLogin;
  script: string;
}

/** A runner that answers every run with `answer` and records what it was asked to run. */
export function fakeRunner(answer: (login: PsqlLogin, script: string) => PsqlResult): SqlRunner & { runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  return {
    runs,
    async run(login, script) {
      runs.push({ login, script });
      return answer(login, script);
    },
  };
}

export const ADMIN_LOGIN: PsqlLogin = {
  host: "postgres",
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: "admin-password-not-a-real-secret",
};
