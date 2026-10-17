// Stand-ins for a site's own PostgreSQL and Keycloak, for the configurations under test/fixtures/configs/matrix/.
// The PostgreSQL server serves TLS from a corp CA for pg.libredb.test on the network libredb_data, which the test
// creates with the labels the base step adopts, so every container of the installation resolves it by that name. The
// Keycloak serves TLS from another corp CA at https://auth.libredb.test:<port>, on the host's loopback interface, and
// holds realm corp with a realm role admin of its own and the provisioning client corp-provisioner with realm-admin.
// Both run images of the release, from images.registry when LIBREDB_E2E_IMAGES_REGISTRY sets it, so nothing else is
// pulled. The fixtures name the corp CA files under /etc/libredb-e2e, which the stand-ins write.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeycloakAdmin, trustingFetch } from "../../../src/adapters/keycloak-admin";
import { embeddedRelease } from "../../../src/cli/release";
import { idFromLocation } from "../../../src/keycloak/requests";
import { imageReference } from "../../../src/release/images";
import { renderPgHba } from "../../../src/render/compose";
import { generateSecret } from "../../../src/secrets/generate";
import { scramSha256Verifier } from "../../../src/secrets/scram";
import { createCa } from "../../../src/tls/ca";
import { issueLeaf } from "../../../src/tls/leaf";
import { PROJECT, REGISTRY, sh } from "./install";

/** The directory of the corp CA files that the matrix fixtures name. */
export const CORP_FILES = "/etc/libredb-e2e";
export const EXTERNAL_POSTGRES = "libredb-e2e-external-pg";
export const EXTERNAL_KEYCLOAK = "libredb-e2e-corp-keycloak";
export const POSTGRES_HOST = "pg.libredb.test";
export const POSTGRES_ADMIN_USER = "corp_dba";
/** postgres.external.adminPasswordEnv of the fixtures. */
export const POSTGRES_ADMIN_ENV = "LIBREDB_PG_ADMIN_PASSWORD";
/** keycloak.external.adminClientSecretEnv of the fixtures. */
export const KEYCLOAK_SECRET_ENV = "LIBREDB_E2E_CORP_ADMIN_SECRET";
const AUTH_HOST = "auth.libredb.test";
const DATA_NETWORK = `${PROJECT}_data`;
const EDGE_NETWORK = `${PROJECT}_edge`;
/** The port of the corp Keycloak, inside its container and on the host's loopback interface alike (default 8443). */
export const KEYCLOAK_PORT = Number(process.env.LIBREDB_E2E_EXTERNAL_KEYCLOAK_PORT ?? "8443");
export const KEYCLOAK_BASE_URL = `https://${AUTH_HOST}:${KEYCLOAK_PORT}`;

/** The external PostgreSQL server: its superuser runs SQL over the local socket, and its admin role has a password. */
export interface ExternalPostgres {
  adminPassword: string;
  /** Runs SQL as the superuser in `database`, or a whole script from standard input when `sql` is undefined. */
  psql(sql: string | undefined, database?: string, stdin?: Uint8Array): string;
}

/** The corp Keycloak: the secret of corp-provisioner. */
export interface ExternalKeycloak {
  provisionerSecret: string;
}

function corpFile(name: string, text: string): void {
  mkdirSync(CORP_FILES, { recursive: true, mode: 0o755 });
  writeFileSync(join(CORP_FILES, name), text, { mode: 0o644 });
}

/** Removes both stand-ins' containers and files; the caller removes the installation's networks. */
export function removeExternals(): void {
  sh(["docker", "rm", "--force", "--volumes", EXTERNAL_POSTGRES, EXTERNAL_KEYCLOAK], false);
  rmSync(CORP_FILES, { recursive: true, force: true });
}

/**
 * Starts the external PostgreSQL server on a new network libredb_data. With `adminRole`, it holds the admin role a
 * managed PostgreSQL service hands over, CREATEROLE and CREATEDB without SUPERUSER, for provisioning installer.
 */
export async function startExternalPostgres(adminRole: boolean): Promise<ExternalPostgres> {
  const scratch = mkdtempSync(join(tmpdir(), "libredb-e2e-corp-pg-"));
  try {
    const now = new Date();
    const ca = await createCa({ commonName: "LibreDB e2e corp database CA", now });
    const leaf = await issueLeaf(ca, [POSTGRES_HOST], now);
    corpFile("corp-db-ca.crt", ca.certPem);
    const serverFiles = join(scratch, "server");
    mkdirSync(serverFiles, { mode: 0o755 });
    chmodSync(serverFiles, 0o755);
    writeFileSync(join(serverFiles, "server.crt"), leaf.certPem, { mode: 0o644 });
    // A throwaway test key, copied into the server container with mode 0600 at start.
    writeFileSync(join(serverFiles, "server.key"), leaf.keyPem, { mode: 0o644 });
    writeFileSync(join(serverFiles, "pg_hba.conf"), renderPgHba(), { mode: 0o644 });
    writeFileSync(
      join(scratch, "server.env"),
      `POSTGRES_PASSWORD=${generateSecret()}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256\n`,
      { mode: 0o600 },
    );
    // The network as the base step creates it, which base then adopts, with the server under its DNS name.
    sh(["docker", "network", "create", "--driver", "bridge", "--label", `com.docker.compose.project=${PROJECT}`,
      "--label", "com.docker.compose.network=data", DATA_NETWORK]);
    // The server copies the files it reads at start, so the scratch directory goes away once it is ready.
    sh([
      "docker", "run", "--detach", "--name", EXTERNAL_POSTGRES, "--network", DATA_NETWORK,
      "--network-alias", POSTGRES_HOST, "--env-file", join(scratch, "server.env"),
      "--volume", `${serverFiles}:/etc/libredb-e2e/source:ro`, "--entrypoint", "sh",
      imageReference(embeddedRelease().images.postgres, REGISTRY),
      "-c",
      [
        "install -d -m 0700 -o postgres -g postgres /etc/libredb-e2e/tls",
        "install -m 0600 -o postgres -g postgres /etc/libredb-e2e/source/server.key /etc/libredb-e2e/tls/server.key",
        "install -m 0644 -o postgres -g postgres /etc/libredb-e2e/source/server.crt /etc/libredb-e2e/tls/server.crt",
        "install -m 0644 -o postgres -g postgres /etc/libredb-e2e/source/pg_hba.conf /etc/libredb-e2e/tls/pg_hba.conf",
        "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/libredb-e2e/tls/server.crt " +
          "-c ssl_key_file=/etc/libredb-e2e/tls/server.key -c hba_file=/etc/libredb-e2e/tls/pg_hba.conf " +
          "-c password_encryption=scram-sha-256",
      ].join(" && "),
    ]);
    const deadline = Date.now() + 180_000;
    // The image's first start initializes the cluster on the local socket alone, so TCP answers once it is done.
    while (sh(["docker", "exec", EXTERNAL_POSTGRES, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], false).code !== 0) {
      if (Date.now() > deadline) throw new Error(`${EXTERNAL_POSTGRES} did not become ready within 180 s`);
      await Bun.sleep(1_000);
    }
    const psql = (sql: string | undefined, database = "postgres", stdin?: Uint8Array) => {
      const command = 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d "$1"';
      const argv = ["docker", "exec", ...(stdin === undefined ? [] : ["--interactive"]), EXTERNAL_POSTGRES, "sh", "-c"];
      if (sql === undefined) return sh([...argv, `${command} -f -`, "sh", database], true, stdin).stdout.trim();
      return sh([...argv, `${command} -c "$2"`, "sh", database, sql]).stdout.trim();
    };
    const adminPassword = generateSecret();
    if (adminRole) {
      const verifier = scramSha256Verifier(adminPassword, crypto.getRandomValues(new Uint8Array(16)));
      psql(`CREATE ROLE ${POSTGRES_ADMIN_USER} LOGIN PASSWORD '${verifier}' CREATEROLE CREATEDB`);
    }
    return { adminPassword, psql };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Starts the corp Keycloak and sets realm corp up as the site's identity team runs it. */
export async function startExternalKeycloak(): Promise<ExternalKeycloak> {
  const scratch = mkdtempSync(join(tmpdir(), "libredb-e2e-corp-kc-"));
  const bootstrapPassword = generateSecret();
  const provisionerSecret = generateSecret();
  const ca = await createCa({ commonName: "Corp test CA", now: new Date() });
  const leaf = await issueLeaf(ca, [AUTH_HOST], new Date());
  corpFile("corp-keycloak-ca.crt", ca.certPem);
  // The container reads its certificate at start and keeps it, so the files go once it serves.
  const tls = join(scratch, "tls");
  mkdirSync(tls, { mode: 0o755 });
  chmodSync(tls, 0o755);
  writeFileSync(join(tls, "tls.crt"), leaf.certPem, { mode: 0o644 });
  // A throwaway test key, which the keycloak user of the image must read.
  writeFileSync(join(tls, "tls.key"), leaf.keyPem, { mode: 0o644 });
  writeFileSync(join(scratch, "keycloak.env"), `KC_BOOTSTRAP_ADMIN_PASSWORD=${bootstrapPassword}\n`, { mode: 0o600 });
  const trusted = trustingFetch([ca.certPem]);
  try {
    sh([
      "docker", "run", "--detach", "--name", EXTERNAL_KEYCLOAK,
      "--publish", `127.0.0.1:${KEYCLOAK_PORT}:${KEYCLOAK_PORT}`,
      "--volume", `${tls}:/etc/corp-tls:ro`, "--env-file", join(scratch, "keycloak.env"),
      "--env", "KC_BOOTSTRAP_ADMIN_USERNAME=admin", "--env", `KC_HTTPS_PORT=${KEYCLOAK_PORT}`,
      "--env", "KC_HTTPS_CERTIFICATE_FILE=/etc/corp-tls/tls.crt",
      "--env", "KC_HTTPS_CERTIFICATE_KEY_FILE=/etc/corp-tls/tls.key",
      "--env", `KC_HOSTNAME=${KEYCLOAK_BASE_URL}`,
      imageReference(embeddedRelease().images.keycloak, REGISTRY),
      "start-dev",
    ]);
    const deadline = Date.now() + 300_000;
    for (;;) {
      const status = await trusted(`${KEYCLOAK_BASE_URL}/realms/master`).then(
        (response) => response.status,
        () => 0,
      );
      if (status === 200) break;
      if (Date.now() > deadline) throw new Error(`${EXTERNAL_KEYCLOAK} did not answer on ${KEYCLOAK_BASE_URL} within 300 s`);
      await Bun.sleep(2_000);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const customer = () =>
    new KeycloakAdmin({
      baseUrl: KEYCLOAK_BASE_URL,
      credentials: { realm: "master", clientId: "admin-cli", username: "admin", password: bootstrapPassword },
      log: () => {},
      fetch: trusted,
    });
  await customer().write("POST", "/admin/realms", { realm: "corp", enabled: true }, [201]);
  await customer().write("POST", "/admin/realms/corp/roles", { name: "admin", description: "Corp IT administrators" }, [201]);
  const created = await customer().write(
    "POST",
    "/admin/realms/corp/clients",
    {
      clientId: "corp-provisioner",
      secret: provisionerSecret,
      publicClient: false,
      standardFlowEnabled: false,
      serviceAccountsEnabled: true,
    },
    [201],
  );
  const provisioner = idFromLocation(created.location, "client corp-provisioner");
  const [management] = await customer().get<{ id: string }[]>("/admin/realms/corp/clients?clientId=realm-management");
  if (management === undefined) throw new Error("realm corp has no realm-management client");
  const realmAdmin = await customer().get<{ id: string; name: string }>(
    `/admin/realms/corp/clients/${management.id}/roles/realm-admin`,
  );
  const account = await customer().get<{ id: string }>(`/admin/realms/corp/clients/${provisioner}/service-account-user`);
  await customer().write("POST", `/admin/realms/corp/users/${account.id}/role-mappings/clients/${management.id}`, [realmAdmin], [204]);
  return { provisionerSecret };
}

/**
 * Joins the corp Keycloak to the installation's network libredb_edge under its public name, as the site's DNS lets the
 * containers reach it; the base step creates that network.
 */
export function connectExternalKeycloak(): void {
  sh(["docker", "network", "connect", "--alias", AUTH_HOST, EDGE_NETWORK, EXTERNAL_KEYCLOAK]);
}
