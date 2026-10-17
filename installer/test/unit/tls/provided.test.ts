import { beforeAll, describe, expect, test } from "bun:test";
import { parseInstallation } from "../../../src/config/schema";
import { ExitCode } from "../../../src/cli/exit-codes";
import { PreflightError } from "../../../src/preflight/docker-checks";
import { createCa, type CertificateAuthority, type KeyedCertificate } from "../../../src/tls/ca";
import { parseCertificates } from "../../../src/tls/inspect";
import { LEAF_VALIDITY_DAYS, issueLeaf } from "../../../src/tls/leaf";
import { loadProvidedTls, providedEndpoints, type ProvidedEndpoint } from "../../../src/tls/provided";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const SITES = [
  { endpoint: "platform", host: "platform.corp" },
  { endpoint: "studio", host: "studio.corp" },
  { endpoint: "auth", host: "auth.corp" },
] as const;

let ca: CertificateAuthority;
let other: CertificateAuthority;
let leaves: Record<string, KeyedCertificate>;
let studioOnly: KeyedCertificate;

beforeAll(async () => {
  ca = await createCa({ commonName: "Corp root CA", now: at(-10) });
  other = await createCa({ commonName: "Somebody else's CA", now: at(-10) });
  leaves = {};
  for (const site of SITES) leaves[site.host] = await issueLeaf(ca, [site.host], at(-1));
  studioOnly = leaves["studio.corp"] as KeyedCertificate;
});

function endpoints(files: Record<string, string> = {}): ProvidedEndpoint[] {
  return SITES.map((site) => ({
    endpoint: site.endpoint,
    host: site.host,
    certificateFile: files[`${site.endpoint}.crt`] ?? `/certs/${site.endpoint}.crt`,
    keyFile: files[`${site.endpoint}.key`] ?? `/certs/${site.endpoint}.key`,
  }));
}

/** The files of a provided installation: a chain and key per endpoint and the CA bundle. */
function filesOf(material: Record<string, KeyedCertificate>, bundle = ca.certPem): Record<string, string> {
  const files: Record<string, string> = { "/certs/ca.crt": bundle };
  for (const site of SITES) {
    const keyed = material[site.endpoint] as KeyedCertificate;
    files[`/certs/${site.endpoint}.crt`] = keyed.certPem;
    files[`/certs/${site.endpoint}.key`] = keyed.keyPem;
  }
  return files;
}

function reader(files: Record<string, string>) {
  return (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return content;
  };
}

function refusal(run: () => unknown): PreflightError {
  try {
    run();
  } catch (error) {
    if (error instanceof PreflightError) return error;
    throw error;
  }
  throw new Error("expected a PreflightError");
}

const byEndpoint = () => ({
  platform: leaves["platform.corp"] as KeyedCertificate,
  studio: leaves["studio.corp"] as KeyedCertificate,
  auth: leaves["auth.corp"] as KeyedCertificate,
});

const load = (files: Record<string, string>, list = endpoints()) =>
  loadProvidedTls({ endpoints: list, caBundleFile: "/certs/ca.crt", readFile: reader(files), now: NOW });

describe("loadProvidedTls", () => {
  test("loads a chain and key per endpoint, the chain re-encoded as canonical PEM", () => {
    const material = byEndpoint();
    const files = filesOf(material);
    files["/certs/platform.crt"] = `comment before the block\n${material.platform.certPem}`;
    const loaded = load(files);
    expect(loaded.map((leaf) => [leaf.endpoint, leaf.host])).toEqual([
      ["platform", "platform.corp"],
      ["studio", "studio.corp"],
      ["auth", "auth.corp"],
    ]);
    expect(loaded[0]?.certPem).toBe(material.platform.certPem);
    expect(loaded[0]?.keyPem).toBe(material.platform.keyPem);
  });

  test("a provided certificate for studio.corp only is refused with 'tls.provided: certificate does not cover platform.corp, auth.corp'", () => {
    const files = filesOf({ platform: studioOnly, studio: studioOnly, auth: studioOnly });
    const error = refusal(() => load(files));
    expect(error.exitCode).toBe(ExitCode.PreflightFailed);
    expect(error.problems).toEqual(["tls.provided: certificate does not cover platform.corp, auth.corp"]);
  });

  test("a key that does not match its certificate is refused with exit 3", () => {
    const material = byEndpoint();
    const files = filesOf({ ...material, platform: { certPem: material.platform.certPem, keyPem: material.studio.keyPem } });
    const error = refusal(() => load(files));
    expect(error.exitCode).toBe(3);
    expect(error.problems).toEqual([
      "tls.provided: the key in /certs/platform.key does not match the certificate in /certs/platform.crt",
    ]);
    expect(error.message).toContain("the key in /certs/platform.key does not match");
  });

  test("an expired certificate is refused with exit 3 naming its file and expiry", async () => {
    const old = await createCa({ commonName: "Corp root CA", now: at(-2000) });
    const expired = await issueLeaf(old, ["platform.corp"], at(-LEAF_VALIDITY_DAYS - 5));
    const files = filesOf({ ...byEndpoint(), platform: expired }, `${ca.certPem}${old.certPem}`);
    const error = refusal(() => load(files));
    expect(error.exitCode).toBe(3);
    const notAfter = parseCertificates(expired.certPem, "x")[0].validToDate.toISOString();
    expect(error.problems).toEqual([`tls.provided: the certificate in /certs/platform.crt expired on ${notAfter}`]);
  });

  test("a chain that does not validate against tls.caBundleFile is refused with exit 3", async () => {
    const foreign = await issueLeaf(other, ["studio.corp"], at(-1));
    const error = refusal(() => load(filesOf({ ...byEndpoint(), studio: foreign })));
    expect(error.exitCode).toBe(3);
    expect(error.problems).toEqual([
      "tls.provided: the chain in /certs/studio.crt does not validate against tls.caBundleFile /certs/ca.crt: " +
        "no certificate in the chain or the CA bundle issued CN=studio.corp",
    ]);
  });

  test("every problem is named in one refusal, the uncovered hosts last", () => {
    const material = byEndpoint();
    const files = filesOf({
      platform: { certPem: material.platform.certPem, keyPem: material.auth.keyPem },
      studio: material.studio,
      auth: studioOnly,
    });
    expect(refusal(() => load(files)).problems).toEqual([
      "tls.provided: the key in /certs/platform.key does not match the certificate in /certs/platform.crt",
      "tls.provided: certificate does not cover auth.corp",
    ]);
  });

  test("unreadable files, a file without a certificate and a key that is not a private key are each named", () => {
    const files = filesOf(byEndpoint());
    delete files["/certs/platform.crt"];
    files["/certs/studio.crt"] = "not a certificate";
    files["/certs/auth.key"] = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    const problems = refusal(() => load(files)).problems;
    expect(problems).toHaveLength(3);
    expect(problems[0]).toStartWith("tls.provided: cannot read /certs/platform.crt: ENOENT");
    expect(problems[1]).toBe("tls.provided: /certs/studio.crt: no PEM certificate found");
    expect(problems[2]).toBe("tls.provided: /certs/auth.key: not a valid unencrypted PEM private key");
  });

  test("an unreadable or invalid CA bundle is refused before any endpoint", () => {
    const files = filesOf(byEndpoint());
    delete files["/certs/ca.crt"];
    expect(refusal(() => load(files)).problems).toEqual([
      "tls.provided: cannot read tls.caBundleFile /certs/ca.crt: ENOENT: no such file or directory, open '/certs/ca.crt'",
    ]);
    files["/certs/ca.crt"] = `${ca.certPem}${ca.keyPem}`;
    expect(refusal(() => load(files)).problems).toEqual([
      "tls.provided: /certs/ca.crt: block 2 is a PRIVATE KEY, but only certificates are allowed",
    ]);
  });

  test("a reader that fails is a refusal, and an error that is not about TLS material is thrown as it is", () => {
    const files = filesOf(byEndpoint());
    const failing = (broken: string) => (path: string) => {
      // A reader that returns no text makes the PEM parser fail with a TypeError, which is a defect, not bad material.
      if (path === broken) return 42 as unknown as string;
      return reader(files)(path);
    };
    const run = (broken: string) =>
      loadProvidedTls({ endpoints: endpoints(), caBundleFile: "/certs/ca.crt", readFile: failing(broken), now: NOW });
    expect(() => run("/certs/studio.crt")).toThrow(TypeError);
    expect(() => run("/certs/ca.crt")).toThrow(TypeError);
  });
});

describe("providedEndpoints", () => {
  const config = (tls: Record<string, unknown>, keycloak: Record<string, unknown> = {}) =>
    parseInstallation({
      apiVersion: "install.libredb.org/v1",
      kind: "LibreDBInstallation",
      metadata: { name: "acme" },
      mode: "docker",
      endpoints: { hosts: { platform: "platform.corp", studio: "studio.corp", auth: "auth.corp" } },
      tls,
      keycloak,
      platform: { organizationName: "Acme" },
    });
  const pair = (name: string) => ({ certificateFile: `/c/${name}.crt`, keyFile: `/c/${name}.key` });

  test("pairs each site the edge serves with its configured files, in site order", () => {
    const installation = config({
      mode: "provided",
      caBundleFile: "/c/ca.crt",
      provided: { platform: pair("p"), studio: pair("s"), auth: pair("a") },
    });
    expect(providedEndpoints(installation, [...SITES])).toEqual([
      { endpoint: "platform", host: "platform.corp", certificateFile: "/c/p.crt", keyFile: "/c/p.key" },
      { endpoint: "studio", host: "studio.corp", certificateFile: "/c/s.crt", keyFile: "/c/s.key" },
      { endpoint: "auth", host: "auth.corp", certificateFile: "/c/a.crt", keyFile: "/c/a.key" },
    ]);
  });

  test("is empty outside tls.mode provided", () => {
    expect(providedEndpoints(config({ mode: "generated" }), [...SITES])).toEqual([]);
  });

  test("refuses a served site without files, which the schema already refuses for a configuration", () => {
    const installation = config(
      { mode: "provided", caBundleFile: "/c/ca.crt", provided: { platform: pair("p"), studio: pair("s") } },
      { mode: "external", external: { baseUrl: "https://auth.corp", adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD" } },
    );
    expect(() => providedEndpoints(installation, [...SITES])).toThrow(
      "tls.provided.auth: no certificateFile and keyFile for auth.corp, which the edge serves",
    );
  });
});
