// Renders /opt/libredb/compose.yaml, the Compose project `libredb` of Docker mode: the edge on network `edge`
// holding every public hostname as an alias, the managed PostgreSQL alone on the internal network `data`, a managed
// Keycloak on both, reachable from the host only on a loopback port, Platform on both, with its migrate job in
// profile `jobs`, which only `docker compose run` starts, and Studio on both, the one service that mounts the
// governance keyring. With an external PostgreSQL there is no postgres service, and network `data` routes to the
// external server instead of being internal. Labels carry the hashes of the CA bundle and the edge certificates, so
// `up -d` recreates exactly the services that read them only at start.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { FileSpec } from "../docker/converge";
import { EnvRenderError } from "../model/env-render";
import type { DesiredInstallation } from "../model/desired";
import { renderStudioEnv, type StudioEnvInputs } from "../model/studio-env";
import { renderKeyring } from "../secrets/keyring";
import type { SealKeyRecord } from "../secrets/store";
import { POSTGRES_NAMES } from "../state/immutable";
import { EDGE_CONFIG_DIR, EDGE_TLS_DIR, EDGE_TLS_MOUNT } from "./caddyfile";

export const INSTALL_ROOT = "/opt/libredb";
export const COMPOSE_PROJECT = "libredb";
export const COMPOSE_FILE = join(INSTALL_ROOT, "compose.yaml");

/** The 0600 env file of the PostgreSQL service, which holds POSTGRES_PASSWORD. */
export const POSTGRES_ENV_FILE = join(INSTALL_ROOT, "env", "postgres.env");

/**
 * The host directory with the PostgreSQL server leaf. The key must be owned by the container's postgres user
 * (uid 999) with mode 0600, or PostgreSQL refuses to start with ssl on.
 */
export const POSTGRES_TLS_DIR = join(INSTALL_ROOT, "tls", "postgres");
export const POSTGRES_LEAF_FILES = { certificate: "server.crt", key: "server.key" } as const;

/** The host directory with the rendered pg_hba.conf. */
export const POSTGRES_CONFIG_DIR = join(INSTALL_ROOT, "postgres");
export const PG_HBA_FILE = join(POSTGRES_CONFIG_DIR, "pg_hba.conf");

/**
 * The 0600 env file of the Keycloak service: KC_DB_PASSWORD, and until the access handover the bootstrap client
 * variables, which compose.yaml therefore never holds.
 */
export const KEYCLOAK_ENV_FILE = join(INSTALL_ROOT, "env", "keycloak.env");

/**
 * The 0600 env files of Platform: the runtime's set of contracts/env-inventory.yaml, and the migrate job's, which
 * alone holds MIGRATE_DATABASE_URL, so the running Platform never holds the owner role's credentials.
 */
export const PLATFORM_ENV_FILE = join(INSTALL_ROOT, "env", "platform.env");
export const PLATFORM_MIGRATE_ENV_FILE = join(INSTALL_ROOT, "env", "platform-migrate.env");

export const PLATFORM_SERVICE = "platform";
export const PLATFORM_MIGRATE_SERVICE = "platform-migrate";

/** The 0600 env file of Studio, with the governance set of the env inventory, which no other service reads. */
export const STUDIO_ENV_FILE = join(INSTALL_ROOT, "env", "studio.env");

/**
 * Studio's governance keyring on the host, readable only by the uid Studio runs as, and where the studio service
 * alone mounts it read-only: the path its GOVERNANCE_PRIVATE_KEYS_FILE names.
 */
export const STUDIO_KEYRING_FILE = join(INSTALL_ROOT, "secrets", "studio-keyring.json");
export const STUDIO_KEYRING_MOUNT = "/etc/libredb/governance/keyring.json";

export const STUDIO_SERVICE = "studio";

/**
 * Studio's hostname, equal to the GOVERNANCE_INSTANCE_ID the installer writes: while v1 runs one replica, a recreated
 * container keeps both and updates the same bridge.studio_instance row.
 */
export const STUDIO_HOSTNAME = "libredb-studio";

/** The Compose profile of the one-shot jobs, which `up` never starts. */
export const JOBS_PROFILE = "jobs";

/** The uid the application images run as, which also owns the Studio keyring. */
export const APP_UID = 1001;
const APP_USER = String(APP_UID);

/** The host directory of the world-readable CA bundle, and where a container mounts it read-only. */
const CA_HOST_DIR = join(INSTALL_ROOT, "ca");
export const CA_MOUNT = "/etc/libredb/ca";
const CA_BUNDLE_MOUNTED = `${CA_MOUNT}/ca.crt`;
const CA_VOLUME = `${CA_HOST_DIR}:${CA_MOUNT}:ro`;

/**
 * The ports the edge publishes, each on the same number inside its container, so a container that calls a public
 * URL through the edge alias reaches the edge on the port of that URL.
 */
export function edgePorts(desired: DesiredInstallation): number[] {
  return desired.edge.ports;
}

/** The port Keycloak serves HTTP on inside its container, and its management port with the health endpoints. */
export const KEYCLOAK_HTTP_PORT = 8080;
const KEYCLOAK_MANAGEMENT_PORT = 9000;

const POSTGRES_TLS_MOUNT = "/etc/libredb/tls";
const POSTGRES_CONFIG_MOUNT = "/etc/libredb/postgres";

const LOGGING = { driver: "json-file", options: { "max-size": "10m", "max-file": "5" } };

/**
 * A service's env file, which Compose may find missing: each deploy step writes its own just before it starts its
 * service, and Compose before 5.0 reads the env file of every service in compose.yaml for any command, ps and logs
 * included, so a file that a later step writes would otherwise stop the commands of the steps before it.
 */
const envFile = (path: string) => [{ path, required: false }];

/**
 * The label with the SHA-256 of the CA bundle, on every long-running service that trusts it: Node reads
 * NODE_EXTRA_CA_CERTS and Keycloak its truststore only at start, so a changed bundle must recreate them.
 */
export const CA_SHA256_LABEL = "org.libredb.ca-sha256";

/** The label with the SHA-256 of the edge certificates, which Caddy reads only at start. */
export const TLS_SHA256_LABEL = "org.libredb.tls-sha256";

/** The label value of TLS material that the tls and base steps have not written yet. */
export const NOT_WRITTEN = "none";

/** The hashes the trust labels carry. */
export interface ComposeTrust {
  caSha256: string;
  tlsSha256: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The trust labels of the CA bundle and of the edge certificates, each certificate named by its host, with `none` for
 * material that does not exist yet. Equal inputs give equal labels, so an unchanged bundle or leaf recreates nothing.
 */
export function composeTrust(
  caBundlePem: string | undefined,
  edgeCertificates: readonly { host: string; pem: string | undefined }[],
): ComposeTrust {
  const present = edgeCertificates.filter((certificate) => certificate.pem !== undefined);
  const tls = edgeCertificates.map((certificate) => `${certificate.host}\n${certificate.pem ?? NOT_WRITTEN}\n`).join("");
  return {
    caSha256: caBundlePem === undefined ? NOT_WRITTEN : sha256(caBundlePem),
    tlsSha256: present.length === 0 ? NOT_WRITTEN : sha256(tls),
  };
}

const caLabels = (trust: ComposeTrust) => ({ [CA_SHA256_LABEL]: trust.caSha256 });

/**
 * Accepts network connections only over TLS and every connection only with SCRAM: no plain TCP, no trust, no md5.
 * The local socket exists only inside the container, where the image's first initialization runs psql on it.
 */
export function renderPgHba(): string {
  return [
    "# Rendered by libredb-installer: network connections need TLS, and every connection needs SCRAM.",
    "local all all scram-sha-256",
    "hostssl all all 0.0.0.0/0 scram-sha-256",
    "hostssl all all ::/0 scram-sha-256",
    "",
  ].join("\n");
}

// The Keycloak image has no curl or wget, so the healthcheck asks /health/ready through bash's /dev/tcp and passes
// only on a 200 status line. It holds no `$`, which Compose would interpolate.
const KEYCLOAK_HEALTHCHECK =
  `exec 3<>/dev/tcp/127.0.0.1/${KEYCLOAK_MANAGEMENT_PORT} && ` +
  "printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && " +
  "head -n 1 <&3 | grep -q ' 200 '";

/** Keycloak's KC_DB_URL: database keycloak on the installation's PostgreSQL server with verify-full. */
export function keycloakJdbcUrl(postgres: DesiredInstallation["postgres"]): string {
  return (
    `jdbc:postgresql://${postgres.host}:${postgres.port}/${POSTGRES_NAMES.keycloakDatabase}` +
    `?sslmode=verify-full&sslrootcert=${CA_BUNDLE_MOUNTED}`
  );
}

function keycloakService(desired: DesiredInstallation, trust: ComposeTrust) {
  const jdbc = keycloakJdbcUrl(desired.postgres);
  return {
    image: desired.images.keycloak,
    restart: "unless-stopped",
    command: ["start"],
    env_file: envFile(KEYCLOAK_ENV_FILE),
    environment: {
      KC_DB: "postgres",
      KC_DB_URL: jdbc,
      KC_DB_USERNAME: POSTGRES_NAMES.roles.keycloak,
      KC_DB_POOL_MAX_SIZE: "20",
      KC_HOSTNAME: desired.urls.auth,
      KC_HOSTNAME_ADMIN: desired.keycloak.adminUrl,
      KC_PROXY_HEADERS: "xforwarded",
      KC_HTTP_ENABLED: "true",
      KC_HEALTH_ENABLED: "true",
      KC_TRUSTSTORE_PATHS: CA_BUNDLE_MOUNTED,
      // Liquibase, which migrates Keycloak's schema, sends usage analytics to config.liquibase.com by default, and no
      // runtime call may leave the customer network unless configured (R11 of installer/docs/ACCEPTANCE.md).
      LIQUIBASE_ANALYTICS_ENABLED: "false",
    },
    // The installer reaches the Admin API and the operator the admin console only through this loopback port;
    // the edge forwards the realm paths alone.
    ports: [
      {
        target: KEYCLOAK_HTTP_PORT,
        host_ip: "127.0.0.1",
        published: String(desired.keycloak.adminPort),
        protocol: "tcp",
      },
    ],
    volumes: [CA_VOLUME],
    labels: caLabels(trust),
    networks: { edge: {}, data: {} },
    healthcheck: {
      test: ["CMD", "bash", "-c", KEYCLOAK_HEALTHCHECK],
      interval: "10s",
      timeout: "5s",
      retries: 10,
      start_period: "120s",
    },
    logging: LOGGING,
  };
}

// What both Platform containers share: the pinned image, the app user, no capabilities and no privilege gain.
const platformBase = (desired: DesiredInstallation) => ({
  image: desired.images.platform,
  user: APP_USER,
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
});

// The liveness route does no I/O, so the container is healthy once the server answers; `verify` reads the readiness
// route. The image has no curl or wget, so node asks, and the command holds no `$`.
const PLATFORM_HEALTHCHECK =
  "fetch('http://127.0.0.1:3000/api/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))";

/**
 * Platform's migrate job: the preflight, `prisma migrate deploy` and the seed, as the owner role of
 * MIGRATE_DATABASE_URL. The platform-migrate step runs it with `docker compose run --rm` before Platform is recreated.
 */
function platformMigrateService(desired: DesiredInstallation) {
  // No restart policy: Compose's default never restarts a container, which a one-shot job needs.
  return {
    ...platformBase(desired),
    profiles: [JOBS_PROFILE],
    command: ["migrate"],
    env_file: envFile(PLATFORM_MIGRATE_ENV_FILE),
    read_only: true,
    tmpfs: ["/tmp"],
    volumes: [CA_VOLUME],
    // PostgreSQL is all the job reaches.
    networks: { data: {} },
    logging: LOGGING,
  };
}

/** Platform's web server, behind the edge on network edge and with PostgreSQL on network data. */
function platformService(desired: DesiredInstallation, trust: ComposeTrust) {
  return {
    ...platformBase(desired),
    restart: "unless-stopped",
    command: ["serve"],
    env_file: envFile(PLATFORM_ENV_FILE),
    read_only: true,
    tmpfs: ["/tmp", "/app/.next/cache"],
    volumes: ["platform-uploads:/app/uploads", CA_VOLUME],
    labels: caLabels(trust),
    networks: { edge: {}, data: {} },
    healthcheck: {
      test: ["CMD", "node", "-e", PLATFORM_HEALTHCHECK],
      interval: "10s",
      timeout: "5s",
      retries: 5,
      start_period: "30s",
    },
    logging: LOGGING,
  };
}

// Readiness answers 503 until Studio has loaded a governance snapshot of a contract it supports, and while it is
// misconfigured or incompatible, so `up --wait` fails the step for a Studio that cannot serve. The image has no curl
// or wget, so node asks, and the command holds no `$`.
const STUDIO_HEALTHCHECK =
  "fetch('http://127.0.0.1:3000/api/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))";

/**
 * Studio's web server, behind the edge on network edge and with PostgreSQL on network data, hardened as the Studio
 * chart's pods are. Its fixed hostname and GOVERNANCE_INSTANCE_ID keep one heartbeat row across recreates.
 * It alone mounts the keyring, in the long syntax without create_host_path, so a keyring missing on the host fails the
 * start instead of becoming a directory there.
 */
function studioService(desired: DesiredInstallation, trust: ComposeTrust) {
  return {
    image: desired.images.studio,
    hostname: STUDIO_HOSTNAME,
    restart: "unless-stopped",
    user: APP_USER,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    env_file: envFile(STUDIO_ENV_FILE),
    read_only: true,
    tmpfs: ["/tmp", "/app/.next/cache"],
    volumes: [
      "studio-data:/app/data",
      CA_VOLUME,
      {
        type: "bind",
        source: STUDIO_KEYRING_FILE,
        target: STUDIO_KEYRING_MOUNT,
        read_only: true,
        bind: { create_host_path: false },
      },
    ],
    labels: caLabels(trust),
    networks: { edge: {}, data: {} },
    healthcheck: {
      test: ["CMD", "node", "-e", STUDIO_HEALTHCHECK],
      interval: "10s",
      timeout: "5s",
      retries: 5,
      start_period: "30s",
    },
    logging: LOGGING,
  };
}

// The characters that make Compose change an unquoted env file value: it interpolates `$`, ends the value at ` #`,
// unquotes quotes and reads backslash escapes; it also trims the value's ends.
const COMPOSE_SPECIAL = /[$#'"\\]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * An env file that `docker compose` reads back with every value verbatim, the variables in the given order and those
 * whose value is undefined left out. A value Compose would change is single-quoted, which Compose takes literally, or
 * double-quoted when it holds a single quote but nothing that Compose reads inside double quotes (`$`, `"`, `\`).
 * A value no quoting carries, or one with a line break, is refused naming the variable only.
 */
export function renderComposeEnvFile(env: Readonly<Record<string, string | undefined>>): string {
  return Object.entries(env)
    .flatMap(([name, value]) => {
      if (value === undefined) return [];
      if (!ENV_NAME.test(name)) throw new EnvRenderError(`${name}: not a valid environment variable name`);
      if (/[\r\n\0]/.test(value)) throw new EnvRenderError(`${name}: the value contains a line break or a NUL character`);
      if (!COMPOSE_SPECIAL.test(value) && value.trim() === value) return [`${name}=${value}\n`];
      if (!value.includes("'")) return [`${name}='${value}'\n`];
      if (!/[$"\\]/.test(value)) return [`${name}="${value}"\n`];
      throw new EnvRenderError(
        `${name}: the value holds a single quote together with $, " or \\, which no Compose env file carries verbatim`,
      );
    })
    .join("");
}

/**
 * Reads an env file that renderComposeEnvFile wrote back into its variables, removing the quotes it added. A line
 * that is not `KEY=value` is refused naming its number, never its content, which may hold a secret.
 */
export function parseComposeEnvFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "" || line.startsWith("#")) return;
    const at = line.indexOf("=");
    if (at <= 0) throw new EnvRenderError(`line ${index + 1} of the env file is not of the form KEY=value`);
    const raw = line.slice(at + 1);
    const quoted = raw.length >= 2 && (raw[0] === "'" || raw[0] === '"') && raw.at(-1) === raw[0];
    entries.set(line.slice(0, at), quoted ? raw.slice(1, -1) : raw);
  });
  return entries;
}

/** Studio's env file: the governance set of the env inventory, readable by root alone like every env file. */
export function studioEnvFile(desired: DesiredInstallation, inputs: StudioEnvInputs): FileSpec {
  const content = renderComposeEnvFile(renderStudioEnv(desired, inputs));
  return { path: STUDIO_ENV_FILE, content, mode: 0o600, uid: 0, gid: 0 };
}

/**
 * Studio's keyring file: the private key of every live seal key, with mode 0400 and the uid Studio runs as for owner,
 * the only user that may read it. A keyring that Studio would refuse, such as one without a live key, is
 * refused here.
 */
export function studioKeyringFile(sealKeys: readonly SealKeyRecord[]): FileSpec {
  return { path: STUDIO_KEYRING_FILE, content: renderKeyring(sealKeys), mode: 0o400, uid: APP_UID, gid: APP_UID };
}

/** The external PostgreSQL server as the compose file records it for db-shell, which reads no configuration. */
export interface ComposeExternalPostgres {
  host: string;
  port: number;
  /** The pinned PostgreSQL image, whose psql reaches the server. */
  psqlImage: string;
}

/** The top-level extension field of compose.yaml that Compose ignores and the installer reads. */
export const COMPOSE_EXTENSION = "x-libredb";

/** The external PostgreSQL server that a rendered compose file records, or undefined for a managed one. */
export function composeExternalPostgres(composeYaml: string): ComposeExternalPostgres | undefined {
  const document = parse(composeYaml) as Record<string, { postgres?: Partial<ComposeExternalPostgres> } | undefined>;
  const recorded = document[COMPOSE_EXTENSION]?.postgres;
  if (recorded === undefined) return undefined;
  const { host, port, psqlImage } = recorded;
  if (typeof host !== "string" || typeof port !== "number" || typeof psqlImage !== "string") {
    throw new Error(`the ${COMPOSE_EXTENSION} field of the compose file has no external PostgreSQL host, port and psql image`);
  }
  return { host, port, psqlImage };
}

function postgresService(desired: DesiredInstallation) {
  return {
    image: desired.images.postgres,
    restart: "unless-stopped",
    command: [
      "postgres",
      "-c",
      "ssl=on",
      "-c",
      `ssl_cert_file=${POSTGRES_TLS_MOUNT}/${POSTGRES_LEAF_FILES.certificate}`,
      "-c",
      `ssl_key_file=${POSTGRES_TLS_MOUNT}/${POSTGRES_LEAF_FILES.key}`,
      "-c",
      `hba_file=${POSTGRES_CONFIG_MOUNT}/pg_hba.conf`,
      "-c",
      "password_encryption=scram-sha-256",
    ],
    env_file: envFile(POSTGRES_ENV_FILE),
    environment: { POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256 --auth-local=scram-sha-256" },
    volumes: [
      "postgres-data:/var/lib/postgresql",
      `${POSTGRES_TLS_DIR}:${POSTGRES_TLS_MOUNT}:ro`,
      `${POSTGRES_CONFIG_DIR}:${POSTGRES_CONFIG_MOUNT}:ro`,
    ],
    networks: { data: {} },
    healthcheck: {
      // TCP on loopback, which the temporary server of the first initialization does not open.
      test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
      start_period: "30s",
    },
    logging: LOGGING,
  };
}

export function renderCompose(desired: DesiredInstallation, trust: ComposeTrust): string {
  const managedPostgres = desired.postgres.managed;
  const external: ComposeExternalPostgres = {
    host: desired.postgres.host,
    port: desired.postgres.port,
    psqlImage: desired.images.postgres,
  };
  const document = {
    name: COMPOSE_PROJECT,
    ...(managedPostgres ? {} : { [COMPOSE_EXTENSION]: { postgres: external } }),
    services: {
      edge: {
        image: desired.images.edge,
        restart: "unless-stopped",
        ports: edgePorts(desired).map((port) => ({ target: port, published: String(port), protocol: "tcp" })),
        volumes: [
          `${EDGE_CONFIG_DIR}:/etc/caddy:ro`,
          `${EDGE_TLS_DIR}:${EDGE_TLS_MOUNT}:ro`,
          "edge-data:/data",
          "edge-config:/config",
        ],
        labels: { ...caLabels(trust), [TLS_SHA256_LABEL]: trust.tlsSha256 },
        networks: {
          // Containers resolve every public hostname to the edge, so they reach the public issuer URL without a DNS
          // hairpin. Behind an upstream proxy the edge serves plain HTTP, so it holds no alias and containers reach
          // the public URLs through that proxy.
          edge: desired.edge.aliases.length === 0 ? {} : { aliases: desired.edge.aliases },
        },
        healthcheck: {
          test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"],
          interval: "10s",
          timeout: "5s",
          retries: 5,
          start_period: "10s",
        },
        logging: LOGGING,
      },
      ...(managedPostgres ? { postgres: postgresService(desired) } : {}),
      ...(desired.keycloak.managed ? { keycloak: keycloakService(desired, trust) } : {}),
      [PLATFORM_MIGRATE_SERVICE]: platformMigrateService(desired),
      [PLATFORM_SERVICE]: platformService(desired, trust),
      [STUDIO_SERVICE]: studioService(desired, trust),
    },
    networks: {
      edge: {},
      // Internal while it holds the managed server, which then has no route out; the apps reach an external server
      // through it.
      data: managedPostgres ? { internal: true } : {},
    },
    volumes: {
      "edge-data": {},
      "edge-config": {},
      ...(managedPostgres ? { "postgres-data": {} } : {}),
      "platform-uploads": {},
      "studio-data": {},
    },
  };
  return stringify(document, { lineWidth: 0, aliasDuplicateObjects: false });
}
