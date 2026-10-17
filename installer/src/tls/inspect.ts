// Reads PEM certificates and reports on a chain: expiry, coverage of a host list, key match and chain validity.
// It uses the X509Certificate of node:crypto, which matches hosts, IP addresses and issuers and verifies signatures
// with the TLS library of the runtime, so those rules are the ones the Node and Bun TLS clients apply.
import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

export const DAY_MS = 86_400_000;

/** TLS material that cannot be used as it is, such as an unreadable file or a CA that cannot issue. */
export class TlsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TlsError";
  }
}

export interface PemBlock {
  label: string;
  der: Buffer;
}

/** A non-empty list of certificates, the first one being the leaf of a chain. */
export type Certificates = [X509Certificate, ...X509Certificate[]];

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END ([A-Z0-9 ]+)-----/g;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Splits PEM text into its blocks. Text between blocks is ignored, as OpenSSL ignores it. */
export function parsePemBlocks(text: string, source: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  for (const match of text.matchAll(PEM_BLOCK)) {
    const label = match[1] as string;
    const end = match[3] as string;
    const base64 = (match[2] as string).replace(/\s+/g, "");
    const index = blocks.length + 1;
    if (end !== label) throw new TlsError(`${source}: block ${index} begins as ${label} and ends as ${end}`);
    if (!BASE64.test(base64)) throw new TlsError(`${source}: block ${index} is not valid base64`);
    blocks.push({ label, der: Buffer.from(base64, "base64") });
  }
  if (text.split("-----BEGIN ").length - 1 !== blocks.length) {
    throw new TlsError(`${source}: a PEM block has no END line`);
  }
  return blocks;
}

/**
 * Parses every certificate of a PEM file in order.
 * Any other block is refused, so a private key never slips into a certificate file or a world-readable CA bundle.
 */
export function parseCertificates(text: string, source: string): Certificates {
  const certificates = parsePemBlocks(text, source).map((block, index) => {
    if (block.label !== "CERTIFICATE") {
      throw new TlsError(`${source}: block ${index + 1} is a ${block.label}, but only certificates are allowed`);
    }
    try {
      return new X509Certificate(block.der);
    } catch (error) {
      throw new TlsError(`${source}: certificate ${index + 1} cannot be parsed`, { cause: error });
    }
  });
  const [first, ...rest] = certificates;
  if (first === undefined) throw new TlsError(`${source}: no PEM certificate found`);
  return [first, ...rest];
}

/** Parses a PEM file that must hold exactly one certificate. */
export function parseCertificate(text: string, source: string): X509Certificate {
  const certificates = parseCertificates(text, source);
  if (certificates.length !== 1) {
    throw new TlsError(`${source}: holds ${certificates.length} certificates where exactly one is expected`);
  }
  return certificates[0];
}

/** Encodes a certificate as PEM with 64-character lines, so the same certificate always gives the same text. */
export function certificateToPem(certificate: X509Certificate): string {
  const lines = certificate.raw.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** The subject with one line per attribute, or an empty string for an empty subject. */
export function subjectOf(certificate: X509Certificate): string {
  // Node and Bun return undefined for an empty subject, although the typings promise a string.
  return (certificate.subject as string | undefined) ?? "";
}

/** Names a certificate in a message by its subject, or by its serial number when the subject is empty. */
export function describeCertificate(certificate: X509Certificate): string {
  const subject = subjectOf(certificate);
  return subject === ""
    ? `the certificate with serial number ${certificate.serialNumber}`
    : subject.replaceAll("\n", ", ");
}

/**
 * Splits hosts into those the certificate covers and those it does not.
 * IP addresses must match an IP SAN, and names a DNS SAN, wildcards included; the subject common name never counts,
 * because current TLS clients ignore it once a certificate has subject alternative names.
 */
export function hostCoverage(
  certificate: X509Certificate,
  hosts: readonly string[],
): { covered: string[]; uncovered: string[] } {
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const host of hosts) {
    const match = isIP(host) === 0 ? certificate.checkHost(host, { subject: "never" }) : certificate.checkIP(host);
    (match === undefined ? uncovered : covered).push(host);
  }
  return { covered, uncovered };
}

/** Whether a PEM private key belongs to the certificate. An unreadable or encrypted key is a TlsError. */
export function keyMatches(certificate: X509Certificate, keyPem: string, source: string): boolean {
  let key: KeyObject;
  try {
    key = createPrivateKey(keyPem);
  } catch (error) {
    throw new TlsError(`${source}: not a valid unencrypted PEM private key`, { cause: error });
  }
  return certificate.checkPrivateKey(key);
}

function validityProblem(certificate: X509Certificate, now: Date): string | undefined {
  if (now.getTime() < certificate.validFromDate.getTime()) {
    return `${describeCertificate(certificate)} is not valid before ${certificate.validFromDate.toISOString()}`;
  }
  if (now.getTime() > certificate.validToDate.getTime()) {
    return `${describeCertificate(certificate)} expired on ${certificate.validToDate.toISOString()}`;
  }
  return undefined;
}

/**
 * Whether `issuer` issued `certificate`: the names, the key identifiers and the keyCertSign usage match,
 * and the signature verifies with the issuer's key.
 */
function issued(issuer: X509Certificate, certificate: X509Certificate): boolean {
  return certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);
}

/**
 * Validates a chain, leaf first and then the intermediates as a server presents them, against the CA bundle.
 * Every certificate on the path must be within its validity at `now`, every issuer must be a CA, and the path must
 * end at a self-signed certificate that the bundle holds: like Node and OpenSSL by default, an intermediate in the
 * bundle is not a trust anchor on its own.
 * Path length and name constraints are not evaluated.
 * Returns undefined for a valid chain and otherwise the first problem found.
 */
export function verifyChain(
  chain: Readonly<Certificates>,
  bundle: readonly X509Certificate[],
  now: Date,
): string | undefined {
  const [leaf, ...intermediates] = chain;
  const candidates = [...bundle, ...intermediates];
  const visited = new Set<string>();
  let current = leaf;
  for (;;) {
    const problem = validityProblem(current, now);
    if (problem !== undefined) return problem;
    visited.add(current.fingerprint256);
    if (issued(current, current)) {
      const trusted = bundle.some((anchor) => anchor.fingerprint256 === current.fingerprint256);
      return trusted ? undefined : `${describeCertificate(current)} is self-signed but not in the CA bundle`;
    }
    const subject = current;
    const issuer = candidates.find((candidate) => !visited.has(candidate.fingerprint256) && issued(candidate, subject));
    if (issuer === undefined) {
      return `no certificate in the chain or the CA bundle issued ${describeCertificate(current)}`;
    }
    if (!issuer.ca) return `${describeCertificate(issuer)} is not a CA but issued ${describeCertificate(current)}`;
    current = issuer;
  }
}

export interface InspectChainInput {
  /** The leaf certificate, followed by the intermediates the server presents. */
  chainPem: string;
  /** The private key of the leaf, when it is available. */
  keyPem?: string;
  caBundlePem: string;
  hosts: readonly string[];
  now: Date;
  /** Names the chain in error messages, such as its file path; its key is named `<source> key`. */
  source?: string;
}

export interface ChainReport {
  subject: string;
  serialNumber: string;
  fingerprint256: string;
  notBefore: Date;
  notAfter: Date;
  /** Whole days until the leaf expires, negative once it has expired. */
  daysLeft: number;
  expired: boolean;
  covered: string[];
  uncovered: string[];
  /** Set only when a key was given. */
  keyMatches?: boolean;
  chainValid: boolean;
  /** Why the chain is not valid, set only when it is not. */
  chainProblem?: string;
}

/** Reports on a PEM chain against a CA bundle. Unreadable input is a TlsError. */
export function inspectChain(input: InspectChainInput): ChainReport {
  const source = input.source ?? "the certificate chain";
  const chain = parseCertificates(input.chainPem, source);
  const bundle = parseCertificates(input.caBundlePem, "the CA bundle");
  const [leaf] = chain;
  const remaining = leaf.validToDate.getTime() - input.now.getTime();
  const report: ChainReport = {
    subject: subjectOf(leaf),
    serialNumber: leaf.serialNumber,
    fingerprint256: leaf.fingerprint256,
    notBefore: leaf.validFromDate,
    notAfter: leaf.validToDate,
    daysLeft: Math.floor(remaining / DAY_MS),
    expired: remaining < 0,
    ...hostCoverage(leaf, input.hosts),
    chainValid: true,
  };
  if (input.keyPem !== undefined) report.keyMatches = keyMatches(leaf, input.keyPem, `${source} key`);
  const problem = verifyChain(chain, bundle, input.now);
  if (problem !== undefined) {
    report.chainValid = false;
    report.chainProblem = problem;
  }
  return report;
}
