// The PostgreSQL URLs of the env inventory. The apps' URLs use pg syntax with sslmode=verify-full and the CA bundle,
// and MIGRATE_DATABASE_URL uses Prisma syntax, whose sslcert and sslaccept=strict the Platform migrator turns into
// that CA with verify-full. Every URL uses the postgresql:// scheme, because Platform refuses postgres://.
import { POSTGRES_NAMES } from "../state/immutable";

/** Where the apps reach PostgreSQL: the managed server's service, or an external server. */
export interface PostgresServer {
  host: string;
  port: number;
}

/** The CA bundle every app container mounts. */
export const CA_BUNDLE_PATH = "/etc/libredb/ca/ca.crt";

/** The schema of Platform's tables. */
export const PLATFORM_SCHEMA = "platform";

const PG_TLS = `sslmode=verify-full&sslrootcert=${CA_BUNDLE_PATH}`;
const PRISMA_TLS = `sslmode=require&sslcert=${CA_BUNDLE_PATH}&sslaccept=strict`;

function databaseUrl(server: PostgresServer, user: string, password: string, query: string): string {
  if (password === "") throw new Error(`no password for ${user}`);
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    throw new Error(`invalid PostgreSQL port ${server.port}`);
  }
  const host = server.host.includes(":") ? `[${server.host}]` : server.host;
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgresql://${credentials}@${host}:${server.port}/${POSTGRES_NAMES.database}?${query}`;
}

/** Platform's runtime DATABASE_URL as libredb_platform, in pg syntax. */
export function platformDatabaseUrl(server: PostgresServer, password: string): string {
  return databaseUrl(server, POSTGRES_NAMES.roles.platform, password, `schema=${PLATFORM_SCHEMA}&${PG_TLS}`);
}

/** Studio's STORAGE_POSTGRES_URL and GOVERNANCE_POSTGRES_URL as libredb_studio, in pg syntax. */
export function studioDatabaseUrl(server: PostgresServer, password: string): string {
  return databaseUrl(server, POSTGRES_NAMES.roles.studio, password, PG_TLS);
}

/** The migrate job's MIGRATE_DATABASE_URL as libredb_owner, in Prisma syntax. */
export function migrateDatabaseUrl(server: PostgresServer, password: string): string {
  return databaseUrl(server, POSTGRES_NAMES.roles.owner, password, `schema=${PLATFORM_SCHEMA}&${PRISMA_TLS}`);
}
