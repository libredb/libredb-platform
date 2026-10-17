import { beforeAll, describe, expect, test } from "bun:test";
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { X509Certificate } from "node:crypto";
import { createCa, type CertificateAuthority } from "../../../src/tls/ca";
import {
  TlsError,
  describeCertificate,
  hostCoverage,
  inspectChain,
  keyMatches,
  parseCertificate,
  parseCertificates,
  verifyChain,
} from "../../../src/tls/inspect";
import { issueLeaf } from "../../../src/tls/leaf";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const EC = { name: "ECDSA", namedCurve: "P-256" };

interface Made {
  cert: x509.X509Certificate;
  key: CryptoKey;
  material: CertificateAuthority;
}

/** Builds certificates the installer never issues: intermediates, issuers without the CA flag, odd validity. */
async function make(options: {
  subject: string;
  issuer?: Made;
  ca: boolean;
  keyUsage?: x509.KeyUsageFlags;
  notBefore: Date;
  notAfter: Date;
}): Promise<Made> {
  const keys = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(options.ca, undefined, true),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
  ];
  if (options.keyUsage !== undefined) extensions.push(new x509.KeyUsagesExtension(options.keyUsage, true));
  if (options.issuer !== undefined) {
    extensions.push(await x509.AuthorityKeyIdentifierExtension.create(options.issuer.cert.publicKey));
  }
  const cert = await x509.X509CertificateGenerator.create({
    subject: options.subject,
    issuer: options.issuer?.cert.subjectName ?? options.subject,
    notBefore: options.notBefore,
    notAfter: options.notAfter,
    publicKey: keys.publicKey,
    signingKey: options.issuer?.key ?? keys.privateKey,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions,
  });
  const keyPem = x509.PemConverter.encode(await crypto.subtle.exportKey("pkcs8", keys.privateKey), "PRIVATE KEY");
  return { cert, key: keys.privateKey, material: { certPem: `${cert.toString("pem")}\n`, keyPem: `${keyPem}\n` } };
}

const CA_USAGE = x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign;

let ca: CertificateAuthority;

beforeAll(async () => {
  ca = await createCa({ commonName: "LibreDB internal CA (acme)", now: at(-1000) });
});

function tlsError(run: () => unknown): TlsError {
  try {
    run();
  } catch (error) {
    if (error instanceof TlsError) return error;
    throw error;
  }
  throw new Error("expected a TlsError");
}

describe("inspectChain", () => {
  test("reports that a certificate for studio.corp does not cover platform.corp and auth.corp", async () => {
    const leaf = await issueLeaf(ca, ["studio.corp"], NOW);
    const report = inspectChain({
      chainPem: leaf.certPem,
      caBundlePem: ca.certPem,
      hosts: ["studio.corp", "platform.corp", "auth.corp"],
      now: NOW,
    });
    expect(report.covered).toEqual(["studio.corp"]);
    expect(report.uncovered).toEqual(["platform.corp", "auth.corp"]);
  });

  test("reports the expiry, a matching key and a valid chain for a fresh leaf", async () => {
    const leaf = await issueLeaf(ca, ["studio.corp", "10.0.0.5"], NOW);
    const cert = new X509Certificate(leaf.certPem);
    const report = inspectChain({
      chainPem: leaf.certPem,
      keyPem: leaf.keyPem,
      caBundlePem: ca.certPem,
      hosts: ["studio.corp", "10.0.0.5"],
      now: NOW,
    });
    expect(report).toEqual({
      subject: "CN=studio.corp",
      serialNumber: cert.serialNumber,
      fingerprint256: cert.fingerprint256,
      notBefore: NOW,
      notAfter: at(825),
      daysLeft: 825,
      expired: false,
      covered: ["studio.corp", "10.0.0.5"],
      uncovered: [],
      keyMatches: true,
      chainValid: true,
    });
  });

  test("leaves keyMatches undefined without a key and reports a key that does not match", async () => {
    const leaf = await issueLeaf(ca, ["studio.corp"], NOW);
    const other = await issueLeaf(ca, ["studio.corp"], NOW);
    const input = { chainPem: leaf.certPem, caBundlePem: ca.certPem, hosts: ["studio.corp"], now: NOW };
    expect(inspectChain(input).keyMatches).toBeUndefined();
    expect(inspectChain({ ...input, keyPem: other.keyPem }).keyMatches).toBe(false);
  });

  test("an expired leaf reports negative days and a chain that fails on the expiry", async () => {
    const leaf = await issueLeaf(ca, ["studio.corp"], at(-826));
    const report = inspectChain({ chainPem: leaf.certPem, caBundlePem: ca.certPem, hosts: ["studio.corp"], now: NOW });
    expect(report.daysLeft).toBe(-1);
    expect(report.expired).toBe(true);
    expect(report.chainValid).toBe(false);
    expect(report.chainProblem).toBe("CN=studio.corp expired on 2026-10-14T12:00:00.000Z");
  });

  test("a leaf that is not valid yet fails the chain", async () => {
    const leaf = await issueLeaf(ca, ["studio.corp"], at(10));
    const report = inspectChain({ chainPem: leaf.certPem, caBundlePem: ca.certPem, hosts: ["studio.corp"], now: NOW });
    expect(report.expired).toBe(false);
    expect(report.chainProblem).toBe("CN=studio.corp is not valid before 2026-10-25T12:00:00.000Z");
  });

  test("a leaf from another CA does not chain to the bundle", async () => {
    const other = await createCa({ commonName: "other CA", now: at(-1) });
    const leaf = await issueLeaf(other, ["studio.corp"], NOW);
    const report = inspectChain({ chainPem: leaf.certPem, caBundlePem: ca.certPem, hosts: ["studio.corp"], now: NOW });
    expect(report.chainValid).toBe(false);
    expect(report.chainProblem).toBe("no certificate in the chain or the CA bundle issued CN=studio.corp");
  });

  test("a bundle of several CAs validates a leaf from any of them", async () => {
    const other = await createCa({ commonName: "other CA", now: at(-1) });
    const leaf = await issueLeaf(other, ["studio.corp"], NOW);
    const report = inspectChain({
      chainPem: leaf.certPem,
      caBundlePem: `${ca.certPem}${other.certPem}`,
      hosts: ["studio.corp"],
      now: NOW,
    });
    expect(report.chainValid).toBe(true);
  });
});

describe("verifyChain", () => {
  test("a chain through an intermediate validates against its root, also when the bundle holds the intermediate", async () => {
    const root = await make({ subject: "CN=Corp Root", ca: true, keyUsage: CA_USAGE, notBefore: at(-100), notAfter: at(3000) });
    const issuing = await make({
      subject: "CN=Corp Issuing CA",
      issuer: root,
      ca: true,
      keyUsage: CA_USAGE,
      notBefore: at(-50),
      notAfter: at(2000),
    });
    const leaf = await issueLeaf(issuing.material, ["studio.corp"], NOW);
    const chain = parseCertificates(`${leaf.certPem}${issuing.material.certPem}`, "chain.pem");
    const roots = parseCertificates(root.material.certPem, "bundle.pem");
    expect(verifyChain(chain, roots, NOW)).toBeUndefined();
    expect(verifyChain([chain[0]], [...roots, ...chain.slice(1)], NOW)).toBeUndefined();
    expect(verifyChain([chain[0]], roots, NOW)).toBe(
      "no certificate in the chain or the CA bundle issued CN=studio.corp",
    );
  });

  test("a bundle that holds an intermediate without its root does not validate, as in Node and OpenSSL", async () => {
    const root = await make({ subject: "CN=Corp Root", ca: true, keyUsage: CA_USAGE, notBefore: at(-100), notAfter: at(3000) });
    const issuing = await make({
      subject: "CN=Corp Issuing CA",
      issuer: root,
      ca: true,
      keyUsage: CA_USAGE,
      notBefore: at(-50),
      notAfter: at(2000),
    });
    const leaf = await issueLeaf(issuing.material, ["studio.corp"], NOW);
    const chain = parseCertificates(`${leaf.certPem}${issuing.material.certPem}`, "chain.pem");
    expect(verifyChain(chain, chain.slice(1), NOW)).toBe(
      "no certificate in the chain or the CA bundle issued CN=Corp Issuing CA",
    );
    const withRoot = parseCertificates(
      `${leaf.certPem}${issuing.material.certPem}${root.material.certPem}`,
      "chain.pem",
    );
    expect(verifyChain(withRoot, parseCertificates(ca.certPem, "bundle.pem"), NOW)).toBe(
      "CN=Corp Root is self-signed but not in the CA bundle",
    );
  });

  test("an expired intermediate fails the chain even while the leaf is valid", async () => {
    const root = await make({ subject: "CN=Corp Root", ca: true, keyUsage: CA_USAGE, notBefore: at(-100), notAfter: at(3000) });
    const issuing = await make({
      subject: "CN=Corp Issuing CA",
      issuer: root,
      ca: true,
      keyUsage: CA_USAGE,
      notBefore: at(-100),
      notAfter: at(-1),
    });
    const leaf = await make({ subject: "CN=studio.corp", issuer: issuing, ca: false, notBefore: at(-10), notAfter: at(100) });
    const chain = parseCertificates(`${leaf.material.certPem}${issuing.material.certPem}`, "chain.pem");
    expect(verifyChain(chain, parseCertificates(root.material.certPem, "bundle.pem"), NOW)).toBe(
      "CN=Corp Issuing CA expired on 2026-10-14T12:00:00.000Z",
    );
  });

  test("an issuer without the CA flag fails the chain", async () => {
    const notCa = await make({ subject: "CN=Not A CA", ca: false, notBefore: at(-10), notAfter: at(100) });
    const leaf = await issueLeaf(notCa.material, ["studio.corp"], NOW);
    const chain = parseCertificates(leaf.certPem, "chain.pem");
    expect(verifyChain(chain, parseCertificates(notCa.material.certPem, "bundle.pem"), NOW)).toBe(
      "CN=Not A CA is not a CA but issued CN=studio.corp",
    );
  });

  test("a self-signed certificate is trusted only when the bundle holds it", async () => {
    const selfSigned = await make({ subject: "CN=studio.corp", ca: false, notBefore: at(-10), notAfter: at(100) });
    const certs = parseCertificates(selfSigned.material.certPem, "self-signed.pem");
    expect(verifyChain(certs, certs, NOW)).toBeUndefined();
    expect(verifyChain(certs, parseCertificates(ca.certPem, "bundle.pem"), NOW)).toBe(
      "CN=studio.corp is self-signed but not in the CA bundle",
    );
  });
});

describe("hostCoverage and keyMatches", () => {
  test("checks IPv4 and IPv6 hosts as IP addresses and ignores the subject common name", async () => {
    const leaf = await issueLeaf(ca, ["10.0.0.5", "fd00::5"], NOW);
    const cert = new X509Certificate(leaf.certPem);
    expect(hostCoverage(cert, ["10.0.0.5", "fd00::5", "fd00::6", "10.0.0.6"])).toEqual({
      covered: ["10.0.0.5", "fd00::5"],
      uncovered: ["fd00::6", "10.0.0.6"],
    });
    const named = await make({ subject: "CN=studio.corp", ca: false, notBefore: at(-1), notAfter: at(1) });
    expect(hostCoverage(new X509Certificate(named.material.certPem), ["studio.corp"]).uncovered).toEqual(["studio.corp"]);
  });

  test("an unreadable private key raises a TlsError naming its source", () => {
    const cert = new X509Certificate(ca.certPem);
    expect(tlsError(() => keyMatches(cert, "not a key", "studio.key")).message).toBe(
      "studio.key: not a valid unencrypted PEM private key",
    );
    expect(keyMatches(cert, ca.keyPem, "ca.key")).toBe(true);
  });

  test("describes a certificate by its subject, or by its serial number when the subject is empty", async () => {
    const host = `${"a".repeat(63)}.corp`;
    const leaf = await issueLeaf(ca, [host], NOW);
    const cert = new X509Certificate(leaf.certPem);
    expect(describeCertificate(cert)).toBe(`the certificate with serial number ${cert.serialNumber}`);
    expect(inspectChain({ chainPem: leaf.certPem, caBundlePem: ca.certPem, hosts: [host], now: NOW }).subject).toBe("");
    const multi = await make({ subject: "CN=studio.corp, O=Acme", ca: false, notBefore: at(-1), notAfter: at(1) });
    expect(describeCertificate(new X509Certificate(multi.material.certPem))).toBe("CN=studio.corp, O=Acme");
  });
});

describe("parseCertificates", () => {
  test("reads every certificate of a PEM file, also with CRLF line ends and text between the blocks", () => {
    const crlf = ca.certPem.replaceAll("\n", "\r\n");
    const certs = parseCertificates(`# corporate roots\r\n${crlf}\r\nsome note\n${ca.certPem}`, "roots.pem");
    expect(certs.map((cert) => cert.fingerprint256)).toEqual([
      new X509Certificate(ca.certPem).fingerprint256,
      new X509Certificate(ca.certPem).fingerprint256,
    ]);
  });

  test("refuses input without a certificate, a private key block, a broken block and undecodable DER", () => {
    expect(tlsError(() => parseCertificates("hello", "empty.pem")).message).toBe("empty.pem: no PEM certificate found");
    expect(tlsError(() => parseCertificates(`${ca.certPem}${ca.keyPem}`, "bundle.pem")).message).toBe(
      "bundle.pem: block 2 is a PRIVATE KEY, but only certificates are allowed",
    );
    const block = (begin: string, body: string, end: string) =>
      `-----BEGIN ${begin}-----\n${body}\n-----END ${end}-----\n`;
    expect(tlsError(() => parseCertificates(block("CERTIFICATE", "AAAA", "PRIVATE KEY"), "mixed.pem")).message).toBe(
      "mixed.pem: block 1 begins as CERTIFICATE and ends as PRIVATE KEY",
    );
    expect(tlsError(() => parseCertificates(block("CERTIFICATE", "@@@@", "CERTIFICATE"), "noise.pem")).message).toBe(
      "noise.pem: block 1 is not valid base64",
    );
    expect(tlsError(() => parseCertificates(`${ca.certPem}-----BEGIN CERTIFICATE-----\nAAAA\n`, "cut.pem")).message).toBe(
      "cut.pem: a PEM block has no END line",
    );
    expect(tlsError(() => parseCertificates(block("CERTIFICATE", "AAAA", "CERTIFICATE"), "der.pem")).message).toBe(
      "der.pem: certificate 1 cannot be parsed",
    );
  });

  test("parseCertificate wants exactly one certificate", () => {
    expect(parseCertificate(ca.certPem, "ca.crt").fingerprint256).toBe(new X509Certificate(ca.certPem).fingerprint256);
    expect(tlsError(() => parseCertificate(`${ca.certPem}${ca.certPem}`, "ca.crt")).message).toBe(
      "ca.crt: holds 2 certificates where exactly one is expected",
    );
  });
});
