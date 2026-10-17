// Decides the TLS material of an installation for the tls step: which leaves it needs, and whether
// the internal CA and each leaf are created, kept or re-issued.
import type { LibreDBInstallation } from "../config/schema";
import type { KeyedCertificate } from "./ca";
import { DAY_MS, TlsError, inspectChain, type ChainReport } from "./inspect";
import { usableCa } from "./leaf";

/** A leaf with fewer days left than this is re-issued by the next apply. */
export const RENEW_BEFORE_DAYS = 30;

/** The managed PostgreSQL server's name on the Docker network `data`: its compose service. */
export const POSTGRES_DOCKER_SERVICE = "postgres";

/** The managed PostgreSQL server's Service in the installation's Kubernetes namespace. */
export const POSTGRES_KUBERNETES_SERVICE = "libredb-postgres";

export interface LeafSpec {
  /** Names the leaf among the installation's TLS material, such as `studio` or `postgres`. */
  name: string;
  hosts: readonly string[];
}

export interface DesiredTls {
  caCommonName: string;
  leaves: readonly LeafSpec[];
}

/** The TLS material found on the host or in the cluster, as PEM, with a property absent when its file is missing. */
export interface ObservedTls {
  ca: Partial<KeyedCertificate>;
  leaves: Readonly<Record<string, Partial<KeyedCertificate> | undefined>>;
}

export type LeafPlan =
  | { name: string; hosts: readonly string[]; action: "issue"; reasons: string[] }
  | { name: string; hosts: readonly string[]; action: "keep"; daysLeft: number };

export interface TlsPlan {
  ca: "create" | "keep";
  leaves: LeafPlan[];
}

/** The names that clients inside the installation use to reach the managed PostgreSQL server. */
export function postgresServerNames(config: LibreDBInstallation): string[] {
  if (config.mode === "docker") return [POSTGRES_DOCKER_SERVICE];
  const service = `${POSTGRES_KUBERNETES_SERVICE}.${config.kubernetes.namespace}`;
  return [POSTGRES_KUBERNETES_SERVICE, service, `${service}.svc`, `${service}.svc.cluster.local`];
}

/**
 * The leaves the internal CA issues: in `tls.mode: generated` one per public endpoint host that the installation
 * serves, a single `edge` leaf for the one host of the ports style, and in every mode one for a managed PostgreSQL
 * server.
 * An external Keycloak serves its own host, so it gets no leaf.
 */
export function desiredTls(config: LibreDBInstallation): DesiredTls {
  const leaves: LeafSpec[] = [];
  const { endpoints } = config;
  if (config.tls.mode === "generated") {
    if (endpoints.style === "ports") {
      // The ports style serves every endpoint on one host, so one leaf covers them all.
      leaves.push({ name: "edge", hosts: [endpoints.host] });
    } else {
      const { platform, studio, auth } = endpoints.hosts;
      leaves.push({ name: "platform", hosts: [platform] }, { name: "studio", hosts: [studio] });
      if (config.keycloak.mode === "managed") leaves.push({ name: "auth", hosts: [auth] });
    }
  }
  if (config.postgres.mode === "managed") leaves.push({ name: "postgres", hosts: postgresServerNames(config) });
  return { caCommonName: `LibreDB internal CA (${config.metadata.name})`, leaves };
}

export interface PlanTlsOptions {
  /** `apply --renew-certificates`: re-issue every leaf from the kept CA, whatever its days left. */
  renewAll?: boolean;
}

/** The reason every present leaf gets under `apply --renew-certificates`. */
export const RENEW_ALL_REASON = "apply --renew-certificates re-issues every leaf";

function planLeaf(
  spec: LeafSpec,
  observed: Partial<KeyedCertificate> | undefined,
  caPem: string,
  now: Date,
  renewAll: boolean,
): LeafPlan {
  const issue = (reasons: string[]): LeafPlan => ({ ...spec, action: "issue", reasons });
  if (observed?.certPem === undefined || observed.keyPem === undefined) {
    return issue(["the certificate or its key is missing"]);
  }
  if (renewAll) return issue([RENEW_ALL_REASON]);
  let report: ChainReport;
  try {
    report = inspectChain({
      chainPem: observed.certPem,
      keyPem: observed.keyPem,
      caBundlePem: caPem,
      hosts: spec.hosts,
      now,
      source: `the ${spec.name} leaf`,
    });
  } catch (error) {
    if (!(error instanceof TlsError)) throw error;
    return issue([`unreadable: ${error.message}`]);
  }
  const reasons: string[] = [];
  if (report.uncovered.length > 0) reasons.push(`does not cover ${report.uncovered.join(", ")}`);
  if (report.keyMatches === false) reasons.push("the key does not match the certificate");
  if (report.chainProblem !== undefined) reasons.push(`does not chain to the internal CA: ${report.chainProblem}`);
  if (report.notAfter.getTime() - now.getTime() < RENEW_BEFORE_DAYS * DAY_MS) {
    reasons.push(`${report.daysLeft} days left, fewer than ${RENEW_BEFORE_DAYS}`);
  }
  return reasons.length > 0 ? issue(reasons) : { ...spec, action: "keep", daysLeft: report.daysLeft };
}

/**
 * Plans the TLS material against what was observed.
 * A missing CA is created and then every leaf is issued from it. A present CA is never re-issued: half of one, a key
 * that does not match, or a CA outside its validity is a TlsError for the operator to resolve, never a reason to
 * replace the CA.
 * A leaf is issued when it is missing, unreadable, does not cover its hosts, does not match its key, does not chain
 * to the CA, or has fewer than 30 days left, and is kept otherwise; with `renewAll` every leaf is issued.
 */
export function planTls(observed: ObservedTls, desired: DesiredTls, now: Date, options: PlanTlsOptions = {}): TlsPlan {
  const { certPem, keyPem } = observed.ca;
  if (certPem === undefined && keyPem === undefined) {
    return {
      ca: "create",
      leaves: desired.leaves.map((spec) => ({ ...spec, action: "issue", reasons: ["the internal CA is new"] })),
    };
  }
  if (certPem === undefined || keyPem === undefined) {
    const [present, missing] = certPem === undefined ? ["private key", "certificate"] : ["certificate", "private key"];
    throw new TlsError(
      `the internal CA ${present} is present but its ${missing} is missing; ` +
        "restore both from a backup, because the installer never replaces a present CA",
    );
  }
  usableCa({ certPem, keyPem }, now);
  return {
    ca: "keep",
    leaves: desired.leaves.map((spec) => planLeaf(spec, observed.leaves[spec.name], certPem, now, options.renewAll === true)),
  };
}
