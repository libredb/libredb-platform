// The internal CA: an ECDSA P-256 root kept for 10 years.
// It exists in every TLS mode, because the managed PostgreSQL server leaf always comes from it,
// and the planner never re-issues it while it is present.
// @peculiar/x509 resolves its algorithms through tsyringe, which needs the Reflect API loaded first.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import type { webcrypto } from "node:crypto";

export const CA_VALIDITY_YEARS = 10;

export const EC_KEY: webcrypto.EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
export const SIGNATURE: webcrypto.EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

/** A certificate with its private key, both PEM: the certificate as `CERTIFICATE`, the key as PKCS#8 `PRIVATE KEY`. */
export interface KeyedCertificate {
  certPem: string;
  keyPem: string;
}

/** The certificate and private key of a CA that issues leaves. */
export type CertificateAuthority = KeyedCertificate;

export interface CreateCaOptions {
  /** The subject common name, which names the CA in every trust store that imports it. */
  commonName: string;
  now: Date;
}

/** Certificate times have whole seconds, so validity is computed from the second that the certificate records. */
export function truncateToSeconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(EC_KEY, true, ["sign", "verify"]);
}

export async function privateKeyPem(key: CryptoKey): Promise<string> {
  return `${x509.PemConverter.encode(await crypto.subtle.exportKey("pkcs8", key), "PRIVATE KEY")}\n`;
}

export function certificatePem(cert: x509.X509Certificate): string {
  return `${cert.toString("pem")}\n`;
}

/** Creates a self-signed root: CA:TRUE with path length 0, keyCertSign and cRLSign, valid from now for 10 years. */
export async function createCa(options: CreateCaOptions): Promise<CertificateAuthority> {
  const keys = await generateKeyPair();
  const notBefore = truncateToSeconds(options.now);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + CA_VALIDITY_YEARS);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: [{ CN: [options.commonName] }],
    notBefore,
    notAfter,
    signingAlgorithm: SIGNATURE,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: certificatePem(cert), keyPem: await privateKeyPem(keys.privateKey) };
}
