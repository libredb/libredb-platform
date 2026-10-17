import { beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { parseInstallation } from "../../../src/config/schema";
import { CA_BUNDLE_MOUNT_PATH, buildCaBundle, caBundleFiles, postgresCaBundleFile } from "../../../src/tls/bundle";
import { createCa, type CertificateAuthority } from "../../../src/tls/ca";
import { TlsError, inspectChain, parseCertificates } from "../../../src/tls/inspect";
import { issueLeaf } from "../../../src/tls/leaf";

const NOW = new Date("2026-10-15T12:00:00Z");

let internal: CertificateAuthority;
let corpA: CertificateAuthority;
let corpB: CertificateAuthority;

beforeAll(async () => {
  internal = await createCa({ commonName: "LibreDB internal CA (acme)", now: NOW });
  corpA = await createCa({ commonName: "Corp Root A", now: NOW });
  corpB = await createCa({ commonName: "Corp Root B", now: NOW });
});

const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256;
const fingerprints = (bundle: string) => parseCertificates(bundle, "the bundle").map((cert) => cert.fingerprint256);

/** The certificate re-encoded as PEM with 64-character lines and LF line ends. */
function canonical(pem: string): string {
  const lines = new X509Certificate(pem).raw.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

function tlsError(run: () => unknown): TlsError {
  try {
    run();
  } catch (error) {
    if (error instanceof TlsError) return error;
    throw error;
  }
  throw new Error("expected a TlsError");
}

function config(tls: Record<string, unknown>, keycloak?: Record<string, unknown>, postgres?: Record<string, unknown>) {
  return parseInstallation({
    apiVersion: "install.libredb.org/v1",
    kind: "LibreDBInstallation",
    metadata: { name: "acme" },
    mode: "docker",
    endpoints: { hosts: { platform: "platform.corp", studio: "studio.corp", auth: "auth.corp" } },
    tls,
    ...(keycloak === undefined ? {} : { keycloak }),
    ...(postgres === undefined ? {} : { postgres }),
    platform: { organizationName: "Acme" },
  });
}

const PROVIDED_TLS = {
  mode: "provided",
  caBundleFile: "/etc/pki/corp-ca.pem",
  provided: {
    platform: { certificateFile: "/c/p.crt", keyFile: "/c/p.key" },
    studio: { certificateFile: "/c/s.crt", keyFile: "/c/s.key" },
  },
};

const PROVIDED_TLS_WITH_AUTH = {
  ...PROVIDED_TLS,
  provided: { ...PROVIDED_TLS.provided, auth: { certificateFile: "/c/a.crt", keyFile: "/c/a.key" } },
};

function externalKeycloak(caBundleFile: string) {
  return {
    mode: "external",
    external: { baseUrl: "https://auth.corp", adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD", caBundleFile },
  };
}

describe("buildCaBundle", () => {
  test("a CA present in two caBundleFile inputs appears once in the bundle", () => {
    const bundle = buildCaBundle(internal.certPem, [
      { source: "/etc/pki/corp-a.pem", pem: corpA.certPem },
      { source: "/etc/pki/corp-all.pem", pem: `${corpA.certPem}${corpB.certPem}` },
    ]);
    expect(fingerprints(bundle)).toEqual([
      fingerprint(internal.certPem),
      fingerprint(corpA.certPem),
      fingerprint(corpB.certPem),
    ]);
  });

  test("writes canonical PEM, internal CA first, whatever the line ends, wrapping and comments of the inputs", () => {
    const body = new X509Certificate(corpA.certPem).raw.toString("base64").match(/.{1,76}/g) ?? [];
    const reflowed = [
      "# Corp Root A",
      "-----BEGIN CERTIFICATE-----",
      ...body,
      "-----END CERTIFICATE-----",
      "",
    ].join("\r\n");
    const bundle = buildCaBundle(internal.certPem, [
      { source: "/etc/pki/corp-a.pem", pem: reflowed },
      { source: "/etc/pki/copy-of-internal.pem", pem: internal.certPem },
    ]);
    expect(bundle).toBe(`${canonical(internal.certPem)}${canonical(corpA.certPem)}`);
  });

  test("the CA of an external PostgreSQL server leads the bundle, because Prisma's sslcert trusts only the first certificate", () => {
    const bundle = buildCaBundle(internal.certPem, [{ source: "/etc/pki/corp-a.pem", pem: corpA.certPem }], [
      { source: "/etc/pki/corp-db.pem", pem: corpB.certPem },
    ]);
    expect(fingerprints(bundle)).toEqual([
      fingerprint(corpB.certPem),
      fingerprint(internal.certPem),
      fingerprint(corpA.certPem),
    ]);
  });

  test("without a caBundleFile the bundle holds only the internal CA", () => {
    expect(buildCaBundle(internal.certPem, [])).toBe(canonical(internal.certPem));
  });

  test("a leaf of a customer CA validates against the bundle", async () => {
    const leaf = await issueLeaf(corpB, ["auth.corp"], NOW);
    const bundle = buildCaBundle(internal.certPem, [{ source: "/etc/pki/corp-b.pem", pem: corpB.certPem }]);
    const report = inspectChain({ chainPem: leaf.certPem, caBundlePem: bundle, hosts: ["auth.corp"], now: NOW });
    expect(report.chainValid).toBe(true);
  });

  test("refuses an input that holds a private key or no certificate, and an internal CA file with two certificates", () => {
    expect(
      tlsError(() => buildCaBundle(internal.certPem, [{ source: "/etc/pki/oops.pem", pem: `${corpA.certPem}${corpA.keyPem}` }]))
        .message,
    ).toBe("/etc/pki/oops.pem: block 2 is a PRIVATE KEY, but only certificates are allowed");
    expect(tlsError(() => buildCaBundle(internal.certPem, [{ source: "/etc/pki/empty.pem", pem: "" }])).message).toBe(
      "/etc/pki/empty.pem: no PEM certificate found",
    );
    expect(tlsError(() => buildCaBundle(`${internal.certPem}${corpA.certPem}`, [])).message).toBe(
      "the internal CA certificate: holds 2 certificates where exactly one is expected",
    );
  });
});

describe("caBundleFiles", () => {
  test("lists tls.caBundleFile when it is configured and nothing otherwise", () => {
    expect(caBundleFiles(config({ mode: "generated" }))).toEqual([]);
    const external = { trustedProxies: ["192.0.2.10/32"] };
    expect(caBundleFiles(config({ mode: "external", caBundleFile: "/etc/pki/corp-ca.pem", external }))).toEqual([
      "/etc/pki/corp-ca.pem",
    ]);
  });

  test("adds keycloak.external.caBundleFile after tls.caBundleFile, so both apps trust the customer's issuer", () => {
    const keycloak = (caBundleFile?: string) => ({
      mode: "external",
      external: { baseUrl: "https://auth.corp", adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD", caBundleFile },
    });
    expect(caBundleFiles(config({ mode: "generated" }, keycloak("/etc/pki/sso-ca.pem")))).toEqual(["/etc/pki/sso-ca.pem"]);
    expect(
      caBundleFiles(
        config(
          {
            mode: "provided",
            caBundleFile: "/etc/pki/corp-ca.pem",
            provided: {
              platform: { certificateFile: "/c/p.crt", keyFile: "/c/p.key" },
              studio: { certificateFile: "/c/s.crt", keyFile: "/c/s.key" },
            },
          },
          keycloak("/etc/pki/sso-ca.pem"),
        ),
      ),
    ).toEqual(["/etc/pki/corp-ca.pem", "/etc/pki/sso-ca.pem"]);
    expect(caBundleFiles(config({ mode: "generated" }, keycloak()))).toEqual([]);
  });

  test("names the caBundleFile of an external PostgreSQL server, and lists it after tls.caBundleFile and the Keycloak CA", () => {
    const external = (caBundleFile?: string) => ({
      mode: "external",
      external: { host: "db.corp", adminUser: "dba", ...(caBundleFile === undefined ? {} : { caBundleFile }) },
    });
    expect(caBundleFiles(config({ mode: "generated" }, undefined, external("/etc/pki/corp-db-ca.pem")))).toEqual([
      "/etc/pki/corp-db-ca.pem",
    ]);
    expect(
      caBundleFiles(config(PROVIDED_TLS_WITH_AUTH, undefined, external("/etc/pki/corp-db-ca.pem"))),
    ).toEqual(["/etc/pki/corp-ca.pem", "/etc/pki/corp-db-ca.pem"]);
    expect(
      caBundleFiles(config(PROVIDED_TLS, externalKeycloak("/etc/pki/sso-ca.pem"), external("/etc/pki/corp-db-ca.pem"))),
    ).toEqual(["/etc/pki/corp-ca.pem", "/etc/pki/sso-ca.pem", "/etc/pki/corp-db-ca.pem"]);
    expect(caBundleFiles(config({ mode: "generated" }, undefined, external()))).toEqual([]);
    expect(postgresCaBundleFile(config({ mode: "generated" }, undefined, external("/etc/pki/corp-db-ca.pem")))).toBe(
      "/etc/pki/corp-db-ca.pem",
    );
    expect(postgresCaBundleFile(config({ mode: "generated" }))).toBeUndefined();
  });

  test("the bundle is mounted at /etc/libredb/ca/ca.crt", () => {
    expect(CA_BUNDLE_MOUNT_PATH).toBe("/etc/libredb/ca/ca.crt");
  });
});
