// The host layout of Docker mode under /opt/libredb: the directories the base step creates with their
// modes, and where the TLS material, the CA bundle and the run logs live.
import { join } from "node:path";
import type { LeafSpec } from "../tls/plan";
import { EDGE_CONFIG_DIR, EDGE_TLS_DIR, edgeLeafFiles } from "../render/caddyfile";
import {
  INSTALL_ROOT,
  POSTGRES_CONFIG_DIR,
  POSTGRES_LEAF_FILES,
  POSTGRES_TLS_DIR,
} from "../render/compose";

export const ENV_DIR = join(INSTALL_ROOT, "env");
export const SECRETS_DIR = join(INSTALL_ROOT, "secrets");
export const TLS_DIR = join(INSTALL_ROOT, "tls");
export const CA_DIR = join(INSTALL_ROOT, "ca");
export const STATE_DIR = join(INSTALL_ROOT, "state");
export const BACKUPS_DIR = join(INSTALL_ROOT, "backups");
export const LOGS_DIR = join(INSTALL_ROOT, "logs");
export const BIN_DIR = join(INSTALL_ROOT, "bin");

/** The copy of the installer binary that the renewal timer runs. */
export const INSTALLER_BINARY = join(BIN_DIR, "libredb-installer");

/** The configuration of the last apply, with its --set overrides, which the renewal timer applies again. */
export const APPLIED_CONFIG_FILE = join(INSTALL_ROOT, "libredb.yaml");

/** The internal CA certificate and private key, which never leave the TLS directory. */
export const INTERNAL_CA_DIR = join(TLS_DIR, "ca");
export const INTERNAL_CA_FILES = {
  certificate: join(INTERNAL_CA_DIR, "ca.crt"),
  key: join(INTERNAL_CA_DIR, "ca.key"),
} as const;

/** The world-readable CA bundle on the host, which every container mounts at /etc/libredb/ca/ca.crt. */
export const CA_BUNDLE_FILE = join(CA_DIR, "ca.crt");

/** The uid and gid of the postgres user in the official PostgreSQL image, which must own the server key. */
export const POSTGRES_UID = 999;

export interface DirectorySpec {
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

const root = (path: string, mode: number): DirectorySpec => ({ path, mode, uid: 0, gid: 0 });

/**
 * The directories of the base step, parents first. Everything that holds a secret or the state is 0700, and the
 * directory of the CA bundle is world-readable because the bundle holds public certificates only.
 */
export const BASE_DIRECTORIES: readonly DirectorySpec[] = [
  root(INSTALL_ROOT, 0o755),
  root(ENV_DIR, 0o700),
  root(SECRETS_DIR, 0o700),
  root(TLS_DIR, 0o700),
  root(CA_DIR, 0o755),
  root(STATE_DIR, 0o700),
  root(BACKUPS_DIR, 0o700),
  root(LOGS_DIR, 0o700),
  root(BIN_DIR, 0o755),
];

/** The directories the TLS step writes into, parents first. */
export const TLS_DIRECTORIES: readonly DirectorySpec[] = [
  root(TLS_DIR, 0o700),
  root(INTERNAL_CA_DIR, 0o700),
  root(EDGE_TLS_DIR, 0o700),
  { path: POSTGRES_TLS_DIR, mode: 0o700, uid: POSTGRES_UID, gid: POSTGRES_UID },
];

/** The directories of the rendered service configuration, which hold no secret. */
export const EDGE_CONFIG_DIRECTORY: DirectorySpec = root(EDGE_CONFIG_DIR, 0o755);
export const POSTGRES_CONFIG_DIRECTORY: DirectorySpec = root(POSTGRES_CONFIG_DIR, 0o755);

/** Where one leaf of the TLS plan lives on the host, and who owns its files. */
export interface LeafFiles {
  certificate: string;
  key: string;
  uid: number;
  gid: number;
}

/** The PostgreSQL leaf goes where the postgres service mounts it; every public endpoint leaf goes to the edge. */
export function leafFiles(leaf: LeafSpec): LeafFiles {
  if (leaf.name === "postgres") {
    return {
      certificate: join(POSTGRES_TLS_DIR, POSTGRES_LEAF_FILES.certificate),
      key: join(POSTGRES_TLS_DIR, POSTGRES_LEAF_FILES.key),
      uid: POSTGRES_UID,
      gid: POSTGRES_UID,
    };
  }
  const [host] = leaf.hosts;
  if (host === undefined || leaf.hosts.length !== 1) {
    throw new Error(`the ${leaf.name} leaf must cover exactly one public hostname, and it covers ${leaf.hosts.length}`);
  }
  const files = edgeLeafFiles(host);
  return { certificate: join(EDGE_TLS_DIR, files.certificate), key: join(EDGE_TLS_DIR, files.key), uid: 0, gid: 0 };
}

/** The run log of one installer run, named by its start time in UTC, such as installer-20261015T093000123Z.log. */
export function runLogFile(start: Date): string {
  const stamp = start.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
  return join(LOGS_DIR, `installer-${stamp}.log`);
}
