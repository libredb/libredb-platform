// The CA bundle: the internal CA and every configured caBundleFile, which both apps trust through
// NODE_EXTRA_CA_CERTS and Keycloak through KC_TRUSTSTORE_PATHS.
import type { LibreDBInstallation } from "../config/schema";
import { certificateToPem, parseCertificate, parseCertificates } from "./inspect";

/** Where every container mounts the bundle. It holds only public certificates, so it is world-readable. */
export const CA_BUNDLE_MOUNT_PATH = "/etc/libredb/ca/ca.crt";

export interface CaBundleInput {
  /** Names the input in error messages, such as its file path. */
  source: string;
  pem: string;
}

/**
 * The caBundleFile of an external PostgreSQL server, which the apps and Keycloak verify it against with verify-full,
 * or undefined.
 */
export function postgresCaBundleFile(config: LibreDBInstallation): string | undefined {
  return config.postgres.mode === "external" ? config.postgres.external.caBundleFile : undefined;
}

/**
 * The configured caBundleFile paths, in the order their certificates join the bundle: tls.caBundleFile, then
 * keycloak.external.caBundleFile, so both apps trust the issuer of a customer's Keycloak, then the CA of an external
 * PostgreSQL server.
 */
export function caBundleFiles(config: LibreDBInstallation): string[] {
  const files = config.tls.caBundleFile === undefined ? [] : [config.tls.caBundleFile];
  const keycloak = config.keycloak.mode === "external" ? config.keycloak.external.caBundleFile : undefined;
  const postgres = postgresCaBundleFile(config);
  return [...files, ...(keycloak === undefined ? [] : [keycloak]), ...(postgres === undefined ? [] : [postgres])];
}

/**
 * Builds the bundle: the certificates of `leading`, then the internal CA, then the certificates of each input in order,
 * each certificate once by its SHA-256 fingerprint, re-encoded as canonical PEM so equal inputs always give the same
 * bytes. `leading` is the CA of an external PostgreSQL server: Platform's migrate job hands the bundle to Prisma as
 * sslcert, which trusts only the first certificate of the file, the internal CA when the server is the managed one.
 * An input that holds a private key or anything else besides certificates is a TlsError.
 */
export function buildCaBundle(
  internalCaPem: string,
  inputs: readonly CaBundleInput[],
  leading: readonly CaBundleInput[] = [],
): string {
  const certificates = [
    ...leading.flatMap((input) => parseCertificates(input.pem, input.source)),
    parseCertificate(internalCaPem, "the internal CA certificate"),
    ...inputs.flatMap((input) => parseCertificates(input.pem, input.source)),
  ];
  const seen = new Set<string>();
  let bundle = "";
  for (const certificate of certificates) {
    if (seen.has(certificate.fingerprint256)) continue;
    seen.add(certificate.fingerprint256);
    bundle += certificateToPem(certificate);
  }
  return bundle;
}
