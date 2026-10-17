// Keycloak users of the interop suite, created in the installation's realm through the Admin REST API as the
// installer's own client libredb-installer, the way the realm's user manager would create them in the console.
// The Admin API is reachable only inside the installation, so each call runs a node script in a one-shot
// container of the installed Platform image on the network libredb_edge, with /opt/libredb/secrets/installer.env
// mounted read-only; the client secret never leaves that container. The docker command is LIBREDB_E2E_DOCKER's.
import { randomBytes } from "node:crypto";
import { docker } from "../helpers/studio";

/** keycloak.realm of test/fixtures/configs/docker.yaml, the default. */
const REALM = "libredb";
const EDGE_NETWORK = "libredb_edge";
const PLATFORM_CONTAINER = "libredb-platform-1";
const INSTALLER_ENV = "/opt/libredb/secrets/installer.env";

/** A user of the realm who holds one of the client roles of `libredb` and signs in with a password alone. */
export interface KeycloakUser {
  /** The Keycloak user id, the `sub` that Platform grants to and Studio keys sessions and events by. */
  id: string;
  username: string;
  email: string;
  password: string;
}

/** A session of a user, as GET /admin/realms/{realm}/users/{id}/sessions lists it. */
export interface KeycloakSession {
  id: string;
  username: string;
}

type Operation =
  | {
      op: "create-user";
      username: string;
      email: string;
      firstName: string;
      lastName: string;
      password: string;
      role: "admin" | "user";
    }
  | { op: "sessions"; userId: string }
  | { op: "delete-user"; userId: string };

// Runs in the container: reads installer.env as the installer writes it (KEY=value lines), takes a client
// credentials token at the in-network Keycloak, and runs each operation of LIBREDB_E2E_KEYCLOAK_OPS in order.
const SCRIPT = String.raw`
import { readFileSync } from "node:fs";
const KEYCLOAK = "http://keycloak:8080";
const realm = process.env.LIBREDB_E2E_REALM;
const env = new Map();
for (const line of readFileSync("/run/libredb/installer.env", "utf8").split("\n")) {
  if (line.trim() === "" || line.startsWith("#")) continue;
  env.set(line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1));
}
const tokenResponse = await fetch(KEYCLOAK + "/realms/" + realm + "/protocol/openid-connect/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.get("KEYCLOAK_INSTALLER_CLIENT_ID"),
    client_secret: env.get("KEYCLOAK_INSTALLER_CLIENT_SECRET"),
  }),
});
if (!tokenResponse.ok) throw new Error("the token request answered HTTP " + tokenResponse.status);
const { access_token: token } = await tokenResponse.json();
async function admin(method, path, body) {
  const response = await fetch(KEYCLOAK + "/admin/realms/" + realm + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(method + " " + path + " answered HTTP " + response.status + " " + (await response.text()));
  }
  return response;
}
const results = [];
for (const operation of JSON.parse(process.env.LIBREDB_E2E_KEYCLOAK_OPS)) {
  if (operation.op === "create-user") {
    const created = await admin("POST", "/users", {
      username: operation.username,
      email: operation.email,
      emailVerified: true,
      firstName: operation.firstName,
      lastName: operation.lastName,
      enabled: true,
      credentials: [{ type: "password", value: operation.password, temporary: false }],
    });
    const id = new URL(created.headers.get("location")).pathname.split("/").pop();
    const clients = await (await admin("GET", "/clients?clientId=libredb")).json();
    const client = clients.find((candidate) => candidate.clientId === "libredb");
    if (client === undefined) throw new Error("the realm has no client libredb");
    const role = await (await admin("GET", "/clients/" + client.id + "/roles/" + operation.role)).json();
    await admin("POST", "/users/" + id + "/role-mappings/clients/" + client.id, [role]);
    results.push({ id });
  } else if (operation.op === "sessions") {
    results.push(await (await admin("GET", "/users/" + operation.userId + "/sessions")).json());
  } else if (operation.op === "delete-user") {
    await admin("DELETE", "/users/" + operation.userId);
    results.push(null);
  } else {
    throw new Error("unknown operation " + operation.op);
  }
}
process.stdout.write(JSON.stringify(results));
`;

function runOperations(operations: Operation[]): unknown[] {
  const image = docker(["inspect", "--format", "{{.Config.Image}}", PLATFORM_CONTAINER]);
  const output = docker([
    "run",
    "--rm",
    "--network",
    EDGE_NETWORK,
    // installer.env is 0600 and owned by root.
    "--user",
    "0",
    "--volume",
    `${INSTALLER_ENV}:/run/libredb/installer.env:ro`,
    "--env",
    `LIBREDB_E2E_REALM=${REALM}`,
    "--env",
    `LIBREDB_E2E_KEYCLOAK_OPS=${JSON.stringify(operations)}`,
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "--eval",
    SCRIPT,
  ]);
  return JSON.parse(output) as unknown[];
}

/**
 * Creates one user per name in `names`, each `<name>-<random suffix>` with an email, a first and last name (so
 * Keycloak asks no profile at the first sign-in), a password that is not temporary and the client role
 * `libredb:<role>`.
 */
export function createKeycloakUsers(names: string[], role: "admin" | "user"): KeycloakUser[] {
  const suffix = randomBytes(4).toString("hex");
  const users = names.map((name) => {
    const username = `${name}-${suffix}`;
    return { username, email: `${username}@libredb.test`, password: `E2e-${randomBytes(12).toString("base64url")}` };
  });
  const created = runOperations(
    users.map((user) => ({
      op: "create-user" as const,
      username: user.username,
      email: user.email,
      firstName: "Interop",
      lastName: user.username,
      password: user.password,
      role,
    })),
  ) as { id: string }[];
  return users.map((user, index) => ({ ...user, id: (created[index] as { id: string }).id }));
}

/** The Keycloak sessions of a user. */
export function keycloakSessions(userId: string): KeycloakSession[] {
  return runOperations([{ op: "sessions", userId }])[0] as KeycloakSession[];
}

/** Deletes users of the realm. */
export function deleteKeycloakUsers(userIds: string[]): void {
  if (userIds.length > 0) runOperations(userIds.map((userId) => ({ op: "delete-user" as const, userId })));
}
