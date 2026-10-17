import { beforeAll, describe, expect, test } from "bun:test";
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { createCa, type CertificateAuthority } from "../../../src/tls/ca";
import { TlsError } from "../../../src/tls/inspect";
import { LEAF_VALIDITY_DAYS, issueLeaf } from "../../../src/tls/leaf";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

let ca: CertificateAuthority;
let caCert: X509Certificate;

beforeAll(async () => {
  ca = await createCa({ commonName: "LibreDB internal CA (acme)", now: NOW });
  caCert = new X509Certificate(ca.certPem);
});

async function tlsError(run: () => Promise<unknown>): Promise<TlsError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof TlsError) return error;
    throw error;
  }
  throw new Error("expected a TlsError");
}

describe("createCa", () => {
  test("creates a self-signed ECDSA P-256 root valid for 10 years with CA:TRUE, path length 0, keyCertSign and cRLSign", () => {
    const cert = new x509.X509Certificate(ca.certPem);
    expect(cert.subject).toBe("CN=LibreDB internal CA (acme)");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.notBefore).toEqual(NOW);
    expect(cert.notAfter).toEqual(new Date("2036-10-15T12:00:00Z"));
    expect(caCert.publicKey.asymmetricKeyType).toBe("ec");
    expect(caCert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(cert.signatureAlgorithm).toMatchObject({ name: "ECDSA", hash: { name: "SHA-256" } });

    const constraints = cert.getExtension(x509.BasicConstraintsExtension);
    expect(constraints?.critical).toBe(true);
    expect(constraints?.ca).toBe(true);
    expect(constraints?.pathLength).toBe(0);
    const usages = cert.getExtension(x509.KeyUsagesExtension);
    expect(usages?.critical).toBe(true);
    expect(usages?.usages).toBe(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign);
    expect(cert.getExtension(x509.SubjectKeyIdentifierExtension)?.keyId).toMatch(/^[0-9a-f]{40}$/);

    expect(caCert.ca).toBe(true);
    expect(caCert.verify(caCert.publicKey)).toBe(true);
    expect(ca.keyPem).toStartWith("-----BEGIN PRIVATE KEY-----\n");
    expect(caCert.checkPrivateKey(createPrivateKey(ca.keyPem))).toBe(true);
  });

  test("drops the milliseconds of now, because certificate times have whole seconds", async () => {
    const other = await createCa({ commonName: "LibreDB internal CA (acme)", now: new Date("2026-10-15T12:00:00.987Z") });
    const cert = new x509.X509Certificate(other.certPem);
    expect(cert.notBefore).toEqual(NOW);
    expect(cert.notAfter).toEqual(new Date("2036-10-15T12:00:00Z"));
  });

  test("every CA gets its own key and serial number", async () => {
    const other = await createCa({ commonName: "LibreDB internal CA (acme)", now: NOW });
    const otherCert = new X509Certificate(other.certPem);
    expect(otherCert.serialNumber).not.toBe(caCert.serialNumber);
    expect(otherCert.checkPrivateKey(createPrivateKey(ca.keyPem))).toBe(false);
  });
});

describe("issueLeaf", () => {
  test("a leaf for studio.example.com verifies against the CA public key and passes X509Certificate.checkHost", async () => {
    const leaf = await issueLeaf(ca, ["studio.example.com"], NOW);
    const cert = new X509Certificate(leaf.certPem);
    expect(cert.verify(caCert.publicKey)).toBe(true);
    expect(cert.checkIssued(caCert)).toBe(true);
    expect(cert.checkHost("studio.example.com", { subject: "never" })).toBe("studio.example.com");
    expect(cert.checkHost("platform.example.com")).toBeUndefined();
    expect(cert.checkPrivateKey(createPrivateKey(leaf.keyPem))).toBe(true);
  });

  test("a leaf for 10.0.0.5 carries an IP SAN and passes X509Certificate.checkIP", async () => {
    const leaf = await issueLeaf(ca, ["10.0.0.5"], NOW);
    const cert = new X509Certificate(leaf.certPem);
    expect(cert.subjectAltName).toBe("IP Address:10.0.0.5");
    expect(cert.checkIP("10.0.0.5")).toBe("10.0.0.5");
    expect(cert.checkIP("10.0.0.6")).toBeUndefined();
    expect(cert.verify(caCert.publicKey)).toBe(true);
  });

  test("a leaf is valid for 825 days with CA:FALSE, digitalSignature, the serverAuth extended key usage and the CA key identifier", async () => {
    const leaf = await issueLeaf(ca, ["studio.example.com"], NOW);
    const cert = new x509.X509Certificate(leaf.certPem);
    expect(LEAF_VALIDITY_DAYS).toBe(825);
    expect(cert.notBefore).toEqual(NOW);
    expect(cert.notAfter).toEqual(at(825));
    expect(cert.subject).toBe("CN=studio.example.com");
    expect(cert.issuer).toBe("CN=LibreDB internal CA (acme)");
    expect(cert.publicKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
    expect(cert.signatureAlgorithm).toMatchObject({ name: "ECDSA", hash: { name: "SHA-256" } });

    const constraints = cert.getExtension(x509.BasicConstraintsExtension);
    expect(constraints?.critical).toBe(true);
    expect(constraints?.ca).toBe(false);
    const usages = cert.getExtension(x509.KeyUsagesExtension);
    expect(usages?.critical).toBe(true);
    expect(usages?.usages).toBe(x509.KeyUsageFlags.digitalSignature);
    expect(cert.getExtension(x509.ExtendedKeyUsageExtension)?.usages).toEqual([x509.ExtendedKeyUsage.serverAuth]);
    const caKeyId = new x509.X509Certificate(ca.certPem).getExtension(x509.SubjectKeyIdentifierExtension)?.keyId;
    expect(cert.getExtension(x509.AuthorityKeyIdentifierExtension)?.keyId).toBe(caKeyId);
    expect(cert.getExtension(x509.SubjectKeyIdentifierExtension)?.keyId).toMatch(/^[0-9a-f]{40}$/);
    expect(cert.getExtension(x509.SubjectAlternativeNameExtension)?.critical).toBe(false);
    expect(leaf.keyPem).toStartWith("-----BEGIN PRIVATE KEY-----\n");
  });

  test("the PostgreSQL leaf names every in-network service name as a DNS SAN", async () => {
    const hosts = [
      "libredb-postgres",
      "libredb-postgres.libredb",
      "libredb-postgres.libredb.svc",
      "libredb-postgres.libredb.svc.cluster.local",
    ];
    const cert = new X509Certificate((await issueLeaf(ca, hosts, NOW)).certPem);
    expect(cert.subjectAltName).toBe(hosts.map((host) => `DNS:${host}`).join(", "));
    for (const host of hosts) expect(cert.checkHost(host, { subject: "never" })).toBe(host);
    expect(cert.subject).toBe("CN=libredb-postgres");
  });

  test("an IPv6 host gets an IP SAN next to a DNS SAN", async () => {
    const cert = new X509Certificate((await issueLeaf(ca, ["auth.corp", "fd00::5"], NOW)).certPem);
    expect(cert.checkHost("auth.corp", { subject: "never" })).toBe("auth.corp");
    expect(cert.checkIP("fd00::5")).toBe("fd00::5");
    expect(cert.checkIP("fd00::6")).toBeUndefined();
  });

  test("a first host longer than 64 characters leaves the subject empty and makes the SAN critical", async () => {
    const host = `${"a".repeat(63)}.corp`;
    const leaf = await issueLeaf(ca, [host], NOW);
    const cert = new x509.X509Certificate(leaf.certPem);
    expect(cert.subject).toBe("");
    expect(cert.getExtension(x509.SubjectAlternativeNameExtension)?.critical).toBe(true);
    expect(new X509Certificate(leaf.certPem).checkHost(host, { subject: "never" })).toBe(host);
  });

  test("a leaf never outlives its CA", async () => {
    const ageing = await createCa({ commonName: "ageing CA", now: new Date("2016-12-01T00:00:00Z") });
    const cert = new x509.X509Certificate((await issueLeaf(ageing, ["studio.corp"], NOW)).certPem);
    expect(cert.notBefore).toEqual(NOW);
    expect(cert.notAfter).toEqual(new Date("2026-12-01T00:00:00Z"));
  });

  test("every leaf gets its own key and serial number", async () => {
    const first = new X509Certificate((await issueLeaf(ca, ["studio.corp"], NOW)).certPem);
    const second = await issueLeaf(ca, ["studio.corp"], NOW);
    expect(new X509Certificate(second.certPem).serialNumber).not.toBe(first.serialNumber);
    expect(first.checkPrivateKey(createPrivateKey(second.keyPem))).toBe(false);
  });

  test("refuses to issue from a CA that has expired or is not valid yet", async () => {
    expect((await tlsError(() => issueLeaf(ca, ["studio.corp"], new Date("2036-10-15T12:00:01Z")))).message).toBe(
      "the CA CN=LibreDB internal CA (acme) is valid only from 2026-10-15T12:00:00.000Z to 2036-10-15T12:00:00.000Z, so it cannot issue a certificate at 2036-10-15T12:00:01.000Z",
    );
    expect((await tlsError(() => issueLeaf(ca, ["studio.corp"], at(-1)))).message).toContain(
      "so it cannot issue a certificate at 2026-10-14T12:00:00.000Z",
    );
  });

  test("refuses a CA key that does not match the CA certificate", async () => {
    const other = await createCa({ commonName: "other CA", now: NOW });
    expect((await tlsError(() => issueLeaf({ certPem: ca.certPem, keyPem: other.keyPem }, ["studio.corp"], NOW))).message).toBe(
      "the private key of the CA CN=LibreDB internal CA (acme) does not match its certificate",
    );
  });

  test("refuses an empty host list, a host that is neither a lowercase DNS name nor an IP address, and a duplicate host", async () => {
    expect((await tlsError(() => issueLeaf(ca, [], NOW))).message).toBe("a leaf certificate needs at least one host");
    const invalid = [
      "Studio.corp",
      "studio_corp",
      "-studio.corp",
      "studio..corp",
      "*.corp",
      `${"a".repeat(64)}.corp`,
      `${"a.".repeat(127)}corp`,
    ];
    for (const host of invalid) {
      expect((await tlsError(() => issueLeaf(ca, [host], NOW))).message).toBe(
        `${host} is neither a lowercase DNS name nor an IP address`,
      );
    }
    expect((await tlsError(() => issueLeaf(ca, ["studio.corp", "studio.corp"], NOW))).message).toBe(
      "studio.corp is listed twice",
    );
  });
});
