// Leaf certificates from the internal CA: one per public endpoint host and one for the PostgreSQL server
// with its in-network service names.
// @peculiar/x509 resolves its algorithms through tsyringe, which needs the Reflect API loaded first.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { createPrivateKey, type X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import {
  EC_KEY,
  SIGNATURE,
  certificatePem,
  generateKeyPair,
  privateKeyPem,
  truncateToSeconds,
  type CertificateAuthority,
  type KeyedCertificate,
} from "./ca";
import { DAY_MS, TlsError, describeCertificate, keyMatches, parseCertificate } from "./inspect";

/** The longest validity that Apple platforms accept for any TLS server certificate, a private CA's included. */
export const LEAF_VALIDITY_DAYS = 825;

// The longest common name that X.509 allows (RFC 5280 upper bound ub-common-name).
const MAX_COMMON_NAME = 64;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isDnsName(host: string): boolean {
  return host.length <= 253 && host.split(".").every((label) => DNS_LABEL.test(label));
}

function subjectAltNames(hosts: readonly string[]): x509.JsonGeneralNames {
  if (hosts.length === 0) throw new TlsError("a leaf certificate needs at least one host");
  const seen = new Set<string>();
  return hosts.map((host) => {
    if (seen.has(host)) throw new TlsError(`${host} is listed twice`);
    seen.add(host);
    if (isIP(host) !== 0) return { type: "ip", value: host };
    if (!isDnsName(host)) throw new TlsError(`${host} is neither a lowercase DNS name nor an IP address`);
    return { type: "dns", value: host };
  });
}

/**
 * Parses a CA and refuses one that cannot issue at `now`: a private key that does not belong to the certificate,
 * or a time outside the certificate's validity.
 */
export function usableCa(ca: CertificateAuthority, now: Date): X509Certificate {
  const certificate = parseCertificate(ca.certPem, "the CA certificate");
  if (!keyMatches(certificate, ca.keyPem, "the CA private key")) {
    throw new TlsError(`the private key of the CA ${describeCertificate(certificate)} does not match its certificate`);
  }
  const { validFromDate, validToDate } = certificate;
  if (now.getTime() < validFromDate.getTime() || now.getTime() > validToDate.getTime()) {
    throw new TlsError(
      `the CA ${describeCertificate(certificate)} is valid only from ${validFromDate.toISOString()} ` +
        `to ${validToDate.toISOString()}, so it cannot issue a certificate at ${now.toISOString()}`,
    );
  }
  return certificate;
}

/**
 * Issues a server certificate for `hosts` with a fresh ECDSA P-256 key: valid from now for 825 days but never past
 * its CA, CA:FALSE, digitalSignature, the serverAuth extended key usage and one DNS or IP SAN per host.
 * The first host is the subject common name when it fits; otherwise the subject is empty and the SAN critical.
 */
export async function issueLeaf(
  ca: CertificateAuthority,
  hosts: readonly string[],
  now: Date,
): Promise<KeyedCertificate> {
  const names = subjectAltNames(hosts);
  const issuer = new x509.X509Certificate(usableCa(ca, now).raw);
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    createPrivateKey(ca.keyPem).export({ type: "pkcs8", format: "der" }),
    EC_KEY,
    false,
    ["sign"],
  );
  const keys = await generateKeyPair();
  const notBefore = truncateToSeconds(now);
  const notAfter = new Date(Math.min(notBefore.getTime() + LEAF_VALIDITY_DAYS * DAY_MS, issuer.notAfter.getTime()));
  const first = hosts[0] as string;
  const commonName = first.length <= MAX_COMMON_NAME ? first : undefined;
  const issuerKeyId = issuer.getExtension(x509.SubjectKeyIdentifierExtension)?.keyId;
  const certificate = await x509.X509CertificateGenerator.create({
    subject: commonName === undefined ? undefined : [{ CN: [commonName] }],
    issuer: issuer.subjectName,
    notBefore,
    notAfter,
    signingAlgorithm: SIGNATURE,
    publicKey: keys.publicKey,
    signingKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      // RFC 5280 4.2.1.6: with an empty subject the subject alternative names must be critical.
      new x509.SubjectAlternativeNameExtension(names, commonName === undefined),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ...(issuerKeyId === undefined ? [] : [new x509.AuthorityKeyIdentifierExtension(issuerKeyId)]),
    ],
  });
  return { certPem: certificatePem(certificate), keyPem: await privateKeyPem(keys.privateKey) };
}
