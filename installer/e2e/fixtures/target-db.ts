// The customer database of the interop suite: a PostgreSQL container on the installation's network libredb_edge,
// which Studio reaches by the container's name, with a role that can only SELECT one table and a role that can also
// INSERT, UPDATE and DELETE in it, the read and write credentials a grant level picks. It runs the PostgreSQL image the
// installation already runs, so nothing is pulled, and publishes no port. The docker command is LIBREDB_E2E_DOCKER's.
import { randomBytes } from "node:crypto";
import type { Credential } from "../helpers/platform";
import { docker } from "../helpers/studio";

/** The container, and the host name Studio resolves on libredb_edge. */
export const TARGET_CONTAINER = "libredb-e2e-target";
const EDGE_NETWORK = "libredb_edge";
const POSTGRES_CONTAINER = "libredb-postgres-1";
const DATABASE = "interop";
const READY_TIMEOUT_MS = 60_000;

export interface TargetDatabase {
  host: string;
  port: number;
  database: string;
  /** The table both roles reach: `schema.name`, with the columns id, item and qty. */
  table: { schema: string; name: string };
  /** A role with SELECT on the table only. */
  read: Credential;
  /** A role with SELECT, INSERT, UPDATE and DELETE on the table. */
  write: Credential;
}

function secret(): string {
  return randomBytes(18).toString("base64url");
}

function psql(sql: string): string {
  const options = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", DATABASE];
  return docker(["exec", TARGET_CONTAINER, "psql", ...options, "-c", sql]);
}

/** Removes the target container of an earlier run, if one is left. */
export function removeTargetDatabase(): void {
  const left = docker(["ps", "--all", "--quiet", "--filter", `name=^/${TARGET_CONTAINER}$`]);
  if (left !== "") docker(["rm", "--force", "--volumes", TARGET_CONTAINER]);
}

/** Starts the target database with a fresh pair of role passwords and waits until it accepts connections over TCP. */
export async function startTargetDatabase(): Promise<TargetDatabase> {
  removeTargetDatabase();
  const image = docker(["inspect", "--format", "{{.Config.Image}}", POSTGRES_CONTAINER]);
  docker([
    "run",
    "--detach",
    "--name",
    TARGET_CONTAINER,
    "--network",
    EDGE_NETWORK,
    "--env",
    `POSTGRES_PASSWORD=${secret()}`,
    "--env",
    `POSTGRES_DB=${DATABASE}`,
    image,
  ]);

  // The image's first start initializes the cluster on the local socket alone, so TCP answers only once the server
  // that stays up is running.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      docker(["exec", TARGET_CONTAINER, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "postgres", "-d", DATABASE]);
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`${TARGET_CONTAINER} did not accept connections within ${READY_TIMEOUT_MS / 1000} s`, {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  const read = { user: "interop_read", password: secret() };
  const write = { user: "interop_write", password: secret() };
  // base64url passwords hold no quote, so they are written into the statements as they are.
  psql(`
    CREATE ROLE ${read.user} LOGIN PASSWORD '${read.password}' CONNECTION LIMIT 10;
    CREATE ROLE ${write.user} LOGIN PASSWORD '${write.password}' CONNECTION LIMIT 10;
    CREATE TABLE public.orders (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      item text NOT NULL,
      qty integer NOT NULL
    );
    INSERT INTO public.orders (item, qty) VALUES ('seed', 1);
    GRANT SELECT ON public.orders TO ${read.user};
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO ${write.user};
    GRANT USAGE ON SEQUENCE public.orders_id_seq TO ${write.user};
  `);
  return {
    host: TARGET_CONTAINER,
    port: 5432,
    database: DATABASE,
    table: { schema: "public", name: "orders" },
    read,
    write,
  };
}

/** The number of rows in the target table, read as the superuser. */
export function targetRowCount(): number {
  return Number(psql("SELECT count(*) FROM public.orders"));
}
