// The Kubernetes side of the browser specs: kubectl against the kind cluster, the target database as a pod in the
// installation's namespace, and Keycloak users created through the Admin API with the managed Keycloak's bootstrap
// admin client, which a port-forward to Service keycloak reaches. The client secret is read from Secret
// libredb-keycloak-config and stays in this process.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

export const NAMESPACE = process.env.LIBREDB_E2E_NAMESPACE ?? "libredb";
const KUBECTL = process.env.KUBECTL ?? "kubectl";
const REALM = "libredb";
export const PLATFORM_URL = process.env.LIBREDB_E2E_PLATFORM_URL ?? "https://platform.libredb.test";
// LIBREDB_E2E_OPENSHIFT=1: the namespace's SCC assigns the pods' uids, and rejects a fixed one outside its range.
const FIXED_UIDS = process.env.LIBREDB_E2E_OPENSHIFT === "1" ? {} : { runAsUser: 999, runAsGroup: 999, fsGroup: 999 };

export function kubectl(args: string[], input?: string): string {
  return execFileSync(KUBECTL, ["-n", NAMESPACE, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function secretValue(name: string, key: string): string {
  const encoded = kubectl(["get", "secret", name, "-o", `jsonpath={.data.${key.replaceAll(".", "\\.")}}`]);
  return Buffer.from(encoded, "base64").toString("utf8");
}

/** psql as the managed server's superuser in the pod libredb-postgres-0, with unaligned tuples-only output. */
export function psqlAsSuperuser(database: string, sql: string): string {
  return kubectl([
    "exec",
    "libredb-postgres-0",
    "--",
    "sh",
    "-c",
    `PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d ${database} -c "$0"`,
    sql,
  ]);
}

function secret(): string {
  return randomBytes(18).toString("base64url");
}

export interface Credential {
  user: string;
  password: string;
}

export interface TargetDatabase {
  host: string;
  port: number;
  database: string;
  table: string;
  read: Credential;
  write: Credential;
}

const TARGET = "e2e-target";
// LIBREDB_E2E_TARGET_NAMESPACE keeps the target database out of the installation's namespace, as a customer's own
// database is, so a test can delete that namespace and restore the installation from a backup.
const TARGET_NAMESPACE = process.env.LIBREDB_E2E_TARGET_NAMESPACE ?? NAMESPACE;

/** kubectl in the target database's namespace: a later -n wins over kubectl()'s. */
function targetKubectl(args: string[], input?: string): string {
  return kubectl(["-n", TARGET_NAMESPACE, ...args], input);
}

/** Starts a PostgreSQL pod and Service e2e-target with a read role and a write role on one table. */
export function startTargetDatabase(image: string): TargetDatabase {
  removeTargetDatabase();
  const superuser = secret();
  targetKubectl(
    ["apply", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: TARGET, labels: { app: TARGET } },
          // Restricted, as the installation's namespace enforces.
          spec: {
            securityContext: { runAsNonRoot: true, ...FIXED_UIDS, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "postgres",
                image,
                env: [
                  { name: "POSTGRES_PASSWORD", value: superuser },
                  { name: "POSTGRES_DB", value: "interop" },
                ],
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                readinessProbe: { exec: { command: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"] }, periodSeconds: 2 },
                volumeMounts: [
                  { name: "data", mountPath: "/var/lib/postgresql" },
                  { name: "run", mountPath: "/var/run/postgresql" },
                ],
              },
            ],
            volumes: [
              { name: "data", emptyDir: {} },
              { name: "run", emptyDir: {} },
            ],
          },
        },
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: TARGET },
          spec: { selector: { app: TARGET }, ports: [{ port: 5432 }] },
        },
      ],
    }),
  );
  targetKubectl(["wait", "--for=condition=Ready", `pod/${TARGET}`, "--timeout=180s"]);
  const read = { user: "e2e_reader", password: secret() };
  const write = { user: "e2e_writer", password: secret() };
  const sql = [
    "CREATE SCHEMA shop;",
    "CREATE TABLE shop.orders (id serial PRIMARY KEY, item text NOT NULL, qty int NOT NULL);",
    "INSERT INTO shop.orders (item, qty) VALUES ('keyboard', 2), ('monitor', 1), ('cable', 5);",
    `CREATE ROLE ${read.user} LOGIN PASSWORD '${read.password}';`,
    `CREATE ROLE ${write.user} LOGIN PASSWORD '${write.password}';`,
    `GRANT USAGE ON SCHEMA shop TO ${read.user}, ${write.user};`,
    `GRANT SELECT ON shop.orders TO ${read.user};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON shop.orders TO ${write.user};`,
    `GRANT USAGE ON SEQUENCE shop.orders_id_seq TO ${write.user};`,
  ].join("\n");
  targetKubectl(["exec", "-i", TARGET, "--", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "interop"], sql);
  return { host: `${TARGET}.${TARGET_NAMESPACE}.svc.cluster.local`, port: 5432, database: "interop", table: "shop.orders", read, write };
}

export function removeTargetDatabase(): void {
  try {
    targetKubectl(["delete", "pod,service", TARGET, "--ignore-not-found", "--wait=true"]);
  } catch {
    // Nothing to remove.
  }
}

export function targetRowCount(): number {
  return Number(targetKubectl(["exec", TARGET, "--", "psql", "-X", "-A", "-t", "-U", "postgres", "-d", "interop", "-c", "SELECT count(*) FROM shop.orders"]));
}

let forward: ChildProcess | undefined;
// Not 18080, the admin port of a Docker install, which a host may already use.
const FORWARD_PORT = Number(process.env.LIBREDB_E2E_KEYCLOAK_PORT ?? "28080");

/** A port-forward to Service keycloak on 127.0.0.1, which reaches the Admin API of a managed Keycloak. */
export async function keycloakAdminUrl(): Promise<string> {
  if (forward === undefined) {
    forward = spawn(KUBECTL, ["-n", NAMESPACE, "port-forward", "svc/keycloak", `${FORWARD_PORT}:8080`], { stdio: "ignore" });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(`http://127.0.0.1:${FORWARD_PORT}/realms/${REALM}`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  return `http://127.0.0.1:${FORWARD_PORT}`;
}

export function stopKeycloakForward(): void {
  forward?.kill();
  forward = undefined;
}

async function adminToken(base: string): Promise<string> {
  const response = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "libredb-bootstrap",
      client_secret: secretValue("libredb-keycloak-config", "keycloak-bootstrap-client-secret"),
    }),
  });
  if (!response.ok) throw new Error(`Keycloak refused the bootstrap client: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

export interface KeycloakUser {
  id: string;
  username: string;
  email: string;
  password: string;
}

/** Creates a user of the realm with a password and the client role libredb:<role>, as the user manager would. */
export async function createKeycloakUser(username: string, role: "admin" | "user"): Promise<KeycloakUser> {
  const base = await keycloakAdminUrl();
  const token = await adminToken(base);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const realm = `${base}/admin/realms/${REALM}`;
  const password = `${secret()}Aa1!`;
  const email = `${username}@e2e.libredb.test`;
  const created = await fetch(`${realm}/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username,
      email,
      emailVerified: true,
      firstName: username,
      lastName: "E2E",
      enabled: true,
      credentials: [{ type: "password", value: password, temporary: false }],
    }),
  });
  if (created.status !== 201) throw new Error(`creating ${username} answered ${created.status}: ${await created.text()}`);
  const id = (created.headers.get("location") ?? "").split("/").pop() as string;
  const clients = (await (await fetch(`${realm}/clients?clientId=libredb`, { headers })).json()) as { id: string }[];
  const client = clients[0] as { id: string };
  const roleRep = await (await fetch(`${realm}/clients/${client.id}/roles/${role}`, { headers })).json();
  const mapped = await fetch(`${realm}/users/${id}/role-mappings/clients/${client.id}`, {
    method: "POST",
    headers,
    body: JSON.stringify([roleRep]),
  });
  if (mapped.status !== 204) throw new Error(`granting libredb:${role} to ${username} answered ${mapped.status}`);
  return { id, username, email, password };
}

export async function deleteKeycloakUser(id: string): Promise<void> {
  const base = await keycloakAdminUrl();
  const token = await adminToken(base);
  await fetch(`${base}/admin/realms/${REALM}/users/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
}
