import { beforeAll, describe, expect, test } from "bun:test";
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { createPrivateKey } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:tls";
import { presentedChain } from "../../../src/adapters/tls-probe";
import {
  EC_KEY,
  SIGNATURE,
  certificatePem,
  createCa,
  generateKeyPair,
  privateKeyPem,
  type CertificateAuthority,
} from "../../../src/tls/ca";
import { issueLeaf, LEAF_VALIDITY_DAYS } from "../../../src/tls/leaf";
import { CATALOGUE } from "../../../src/verify/catalogue";
import { EDGE_TLS_MIN_DAYS, edgeTlsCheck, type EdgeEndpoint, type EdgeTlsContext } from "../../../src/verify/edge-tls";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const PLATFORM = { host: "platform.libredb.test", port: 443 };
const STUDIO = { host: "studio.libredb.test", port: 443 };

let ca: CertificateAuthority;
let other: CertificateAuthority;

beforeAll(async () => {
  ca = await createCa({ commonName: "LibreDB internal CA (e2e)", now: at(-2000) });
  other = await createCa({ commonName: "Somebody else's CA", now: at(-2000) });
});

/** A leaf for the host that has `days` days left at NOW. */
const leafWith = async (issuer: CertificateAuthority, hosts: string[], days: number) =>
  (await issueLeaf(issuer, hosts, at(days - LEAF_VALIDITY_DAYS))).certPem;

function context(chains: Record<string, string | Error>, endpoints: EdgeEndpoint[] = [PLATFORM, STUDIO]) {
  const asked: string[] = [];
  const edgeTls: EdgeTlsContext = {
    endpoints,
    readCaBundle: () => ca.certPem,
    async presentedChain(endpoint) {
      asked.push(`${endpoint.host}:${endpoint.port}`);
      const chain = chains[endpoint.host];
      if (chain === undefined) throw new Error(`no chain for ${endpoint.host}`);
      if (chain instanceof Error) throw chain;
      return chain;
    },
    now: () => NOW.getTime(),
  };
  return { edgeTls, asked };
}

describe("edge-tls", () => {
  test("a leaf with 29 days left fails edge-tls naming the host and the days", async () => {
    const { edgeTls } = context({
      [PLATFORM.host]: await leafWith(ca, [PLATFORM.host], 400),
      [STUDIO.host]: await leafWith(ca, [STUDIO.host], 29),
    });
    expect(EDGE_TLS_MIN_DAYS).toBe(30);
    expect(await edgeTlsCheck.run({ edgeTls })).toEqual({
      passed: false,
      cause: "studio.libredb.test:443 presents a certificate with 29 days left, fewer than 30",
    });
  });

  test("passes when every endpoint presents a chain to the CA bundle that covers its host with 30 or more days left", async () => {
    const { edgeTls, asked } = context({
      [PLATFORM.host]: await leafWith(ca, [PLATFORM.host], 30),
      [STUDIO.host]: await leafWith(ca, [STUDIO.host], 825),
    });
    expect(await edgeTlsCheck.run({ edgeTls })).toEqual({ passed: true });
    expect(asked).toEqual(["platform.libredb.test:443", "studio.libredb.test:443"]);
  });

  test("names every endpoint whose chain does not validate, does not cover its host, or cannot be reached", async () => {
    const { edgeTls } = context(
      {
        [PLATFORM.host]: await leafWith(other, [PLATFORM.host], 400),
        [STUDIO.host]: await leafWith(ca, ["platform.libredb.test"], 400),
        "auth.libredb.test": new Error("connect ECONNREFUSED 127.0.0.1:443"),
      },
      [PLATFORM, STUDIO, { host: "auth.libredb.test", port: 443 }],
    );
    const outcome = await edgeTlsCheck.run({ edgeTls });
    expect(outcome.passed).toBe(false);
    const cause = (outcome as { cause: string }).cause;
    expect(cause).toContain(
      "platform.libredb.test:443 presents a chain that does not validate against the CA bundle: " +
        "no certificate in the chain or the CA bundle issued CN=platform.libredb.test",
    );
    expect(cause).toContain("studio.libredb.test:443 presents a certificate that does not cover studio.libredb.test");
    expect(cause).toContain("auth.libredb.test:443 cannot be reached over TLS: connect ECONNREFUSED 127.0.0.1:443");
  });

  test("an expired leaf is reported once as expired", async () => {
    const { edgeTls } = context({ [PLATFORM.host]: await leafWith(ca, [PLATFORM.host], -2) }, [PLATFORM]);
    const outcome = await edgeTlsCheck.run({ edgeTls });
    expect(outcome.passed).toBe(false);
    expect((outcome as { cause: string }).cause).toStartWith("platform.libredb.test:443 presents a chain that does not validate");
  });

  test("joins the catalogue", () => {
    expect(CATALOGUE.map((check) => check.id)).toContain("edge-tls");
  });
});

/**
 * A CA as a corporate PKI issues one, without the path length limit of the internal CA: self-signed, or issued by
 * `issuer`, valid from 1000 days before NOW to 2000 days after it.
 */
async function corporateCa(commonName: string, issuer?: CertificateAuthority): Promise<CertificateAuthority> {
  const keys = await generateKeyPair();
  const parent = issuer === undefined ? undefined : new x509.X509Certificate(issuer.certPem);
  const signingKey =
    issuer === undefined
      ? keys.privateKey
      : await crypto.subtle.importKey(
          "pkcs8",
          createPrivateKey(issuer.keyPem).export({ type: "pkcs8", format: "der" }),
          EC_KEY,
          false,
          ["sign"],
        );
  const certificate = await x509.X509CertificateGenerator.create({
    subject: `CN=${commonName}`,
    issuer: parent?.subject ?? `CN=${commonName}`,
    notBefore: at(-1000),
    notAfter: at(2000),
    publicKey: keys.publicKey,
    signingKey,
    signingAlgorithm: SIGNATURE,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ...(parent === undefined ? [] : [await x509.AuthorityKeyIdentifierExtension.create(parent.publicKey)]),
    ],
  });
  return { certPem: certificatePem(certificate), keyPem: await privateKeyPem(keys.privateKey) };
}

/** A TLS server on a free loopback port that presents `certPem`, a leaf and any intermediates, with the leaf's key. */
async function tlsServer(certPem: string, keyPem: string): Promise<{ server: Server; port: number }> {
  const server = createServer({ cert: certPem, key: keyPem }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

describe("edge-tls through the TLS probe", () => {
  test("a leaf issued by an intermediate passes when the server presents the intermediate and the CA bundle holds only the root", async () => {
    const root = await corporateCa("Acme root CA");
    const intermediate = await corporateCa("Acme issuing CA", root);
    const leaf = await issueLeaf(intermediate, [PLATFORM.host], at(-100));
    const chained = await tlsServer(`${leaf.certPem}${intermediate.certPem}`, leaf.keyPem);
    const alone = await tlsServer(leaf.certPem, leaf.keyPem);
    const run = (port: number) =>
      edgeTlsCheck.run({
        edgeTls: {
          endpoints: [{ host: PLATFORM.host, port }],
          readCaBundle: () => root.certPem,
          presentedChain: (endpoint) =>
            presentedChain({ address: "127.0.0.1", port: endpoint.port, servername: endpoint.host }),
          now: () => NOW.getTime(),
        },
      });
    try {
      expect(await run(chained.port)).toEqual({ passed: true });
      // The same leaf without its intermediate has no path to the root, so the intermediate the server presents counts.
      expect(await run(alone.port)).toEqual({
        passed: false,
        cause:
          `${PLATFORM.host}:${alone.port} presents a chain that does not validate against the CA bundle: ` +
          `no certificate in the chain or the CA bundle issued CN=${PLATFORM.host}`,
      });
    } finally {
      chained.server.close();
      alone.server.close();
    }
  });
});
