// The names of the Kubernetes objects of an installation that the Helm chart charts/libredb-platform deploys. The
// chart's templates name the same objects; a chart test renders them and compares, so the two never drift.
// Every name is fixed, like the installer's Kubernetes constants (Service libredb-postgres), so a namespace holds one
// installation.
import { POSTGRES_KUBERNETES_SERVICE } from "../tls/plan";

/** The Service of a managed Keycloak; Platform's KEYCLOAK_ADMIN_URL of a managed Keycloak is http://keycloak:8080. */
export const KEYCLOAK_SERVICE = "keycloak";

export const K8S_NAMES = {
  /** Generated secrets and seal keys, never overwritten once generated. */
  secretStore: "libredb-secrets",
  /** The installer state (installer/src/state/store.ts), which holds no secret value. */
  state: "libredb-installer-state",
  /** The internal CA and the leaves it issued, as PEM. */
  tls: "libredb-tls",
  /** The CA bundle every app container mounts at /etc/libredb/ca/ca.crt. */
  caBundle: "libredb-ca",
  /** Platform's runtime environment, for `serve` only. */
  platformEnv: "libredb-platform-env",
  /** The migrate job's environment, the only place MIGRATE_DATABASE_URL lives. */
  migrateEnv: "libredb-platform-migrate-env",
  /** The managed PostgreSQL server: its Service, which the leaf covers, and its objects. */
  postgres: POSTGRES_KUBERNETES_SERVICE,
  /** The superuser password of the managed PostgreSQL server, as POSTGRES_PASSWORD. */
  postgresSuperuser: "libredb-postgres-superuser",
  /** The managed server's leaf and key. */
  postgresTls: "libredb-postgres-tls",
  /** pg_hba.conf of the managed server. */
  postgresConfig: "libredb-postgres-config",
  /** The provisioning script of a managed server, with SCRAM verifiers only. */
  postgresProvision: "libredb-postgres-provision",
  /** The script a DBA runs on an external server with provisioning manual, with SCRAM verifiers only. */
  postgresDbaScript: "libredb-postgres-dba-script",
  /** A managed Keycloak's database password and bootstrap admin client. */
  keycloakEnv: "libredb-keycloak-env",
  /** The Caddyfile of a managed Keycloak's edge, the installer's auth site behind the ingress. */
  keycloakEdge: "libredb-keycloak-edge",
  /** Studio's network environment of the installer (NO_PROXY, and HTTPS_PROXY with a proxy), read through studio.extraEnvFrom. */
  studioNetworkEnv: "libredb-studio-network-env",
  /** The jobs' gzipped bundle, which the bootstrap job copies from its hook ConfigMap for the keycloak-configure job. */
  jobsBundle: "libredb-jobs",
  /** What the keycloak-configure job needs: the client secrets and the temporary passwords. */
  keycloakConfig: "libredb-keycloak-config",
  /** The ingress leaves of tls.mode generated, one kubernetes.io/tls Secret per endpoint. */
  ingressTls: (endpoint: "platform" | "studio" | "auth") => `libredb-tls-${endpoint}`,
} as const;

/** The plain HTTP port of a managed Keycloak's edge, which the ingress forwards hosts.auth to. */
export const KEYCLOAK_EDGE_PORT = 8081;

/** The bootstrap admin client of a managed Keycloak in realm master, as the installer's handover names it. */
export const BOOTSTRAP_CLIENT = "libredb-bootstrap";

/** The secret store's names besides the installer's generated secrets. */
export const STORE_KEYS = {
  sealKeys: "seal-keys.json",
  keycloakBootstrapSecret: "keycloak-bootstrap-client-secret",
  firstAdminPassword: "first-admin-password",
  userManagerPassword: "user-manager-password",
} as const;

/** The workloads the bootstrap job restarts when an object they read at start changed. */
export const WORKLOADS = {
  platform: { kind: "deployments", name: "libredb-platform" },
  studio: { kind: "deployments", name: "libredb-studio" },
  keycloak: { kind: "deployments", name: KEYCLOAK_SERVICE },
  postgres: { kind: "statefulsets", name: POSTGRES_KUBERNETES_SERVICE },
} as const;

export type Workload = (typeof WORKLOADS)[keyof typeof WORKLOADS];

/** The label of every object the jobs write, which names the installation: never a Helm or Argo CD tracking label. */
export const INSTALLATION_LABEL = "install.libredb.org/installation";

/** The key of the gzipped bundle in its ConfigMaps. */
export const JOBS_BUNDLE_KEY = "libredb-jobs.cjs.gz";

/** Where the chart mounts the operator's inputs into the bootstrap job. */
export const INPUT_DIR = "/etc/libredb/inputs";

/** The keys of the Studio Secret, which the Studio chart reads as secrets.existingSecret. */
export const STUDIO_SECRET_KEYS = {
  jwtSecret: "jwt-secret",
  oidcClientId: "oidc-client-id",
  oidcClientSecret: "oidc-client-secret",
  storagePostgresUrl: "storage-postgres-url",
  governancePostgresUrl: "governance-postgres-url",
  governancePrivateKeys: "governance-private-keys",
  storageEncryptionKey: "storage-encryption-key",
} as const;
