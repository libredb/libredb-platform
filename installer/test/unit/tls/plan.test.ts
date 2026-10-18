import { beforeAll, describe, expect, test } from "bun:test";
import { parseInstallation } from "../../../src/config/schema";
import { createCa, type CertificateAuthority } from "../../../src/tls/ca";
import { TlsError } from "../../../src/tls/inspect";
import { issueLeaf } from "../../../src/tls/leaf";
import { RENEW_BEFORE_DAYS, desiredTls, planTls, type DesiredTls } from "../../../src/tls/plan";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

let ca: CertificateAuthority;

beforeAll(async () => {
  ca = await createCa({ commonName: "LibreDB internal CA (acme)", now: at(-1000) });
});

const STUDIO: DesiredTls = { caCommonName: "LibreDB internal CA (acme)", leaves: [{ name: "studio", hosts: ["studio.corp"] }] };

function tlsError(run: () => unknown): TlsError {
  try {
    run();
  } catch (error) {
    if (error instanceof TlsError) return error;
    throw error;
  }
  throw new Error("expected a TlsError");
}

function config(overrides: Record<string, unknown> = {}) {
  return parseInstallation({
    apiVersion: "install.libredb.org/v1",
    kind: "LibreDBInstallation",
    metadata: { name: "acme" },
    mode: "docker",
    endpoints: { hosts: { platform: "platform.corp", studio: "studio.corp", auth: "auth.corp" } },
    platform: { organizationName: "Acme", licenseFile: "/etc/libredb/platform.license" },
    ...overrides,
  });
}

describe("planTls", () => {
  test("re-issues a leaf with 29 days left and keeps one with 31 days left", async () => {
    const ending = await issueLeaf(ca, ["studio.corp"], at(29 - 825));
    const fine = await issueLeaf(ca, ["platform.corp"], at(31 - 825));
    const plan = planTls(
      { ca: { certPem: ca.certPem, keyPem: ca.keyPem }, leaves: { studio: ending, platform: fine } },
      {
        caCommonName: "LibreDB internal CA (acme)",
        leaves: [
          { name: "studio", hosts: ["studio.corp"] },
          { name: "platform", hosts: ["platform.corp"] },
        ],
      },
      NOW,
    );
    expect(RENEW_BEFORE_DAYS).toBe(30);
    expect(plan).toEqual({
      ca: "keep",
      leaves: [
        { name: "studio", hosts: ["studio.corp"], action: "issue", reasons: ["29 days left, fewer than 30"] },
        { name: "platform", hosts: ["platform.corp"], action: "keep", daysLeft: 31 },
      ],
    });
  });

  test("renewing re-issues every leaf, also one with years left, and keeps the CA", async () => {
    const fresh = await issueLeaf(ca, ["studio.corp"], NOW);
    const observed = { ca: { certPem: ca.certPem, keyPem: ca.keyPem }, leaves: { studio: fresh } };
    expect(planTls(observed, STUDIO, NOW).leaves).toEqual([{ name: "studio", hosts: ["studio.corp"], action: "keep", daysLeft: 825 }]);
    expect(planTls(observed, STUDIO, NOW, { renewAll: true })).toEqual({
      ca: "keep",
      leaves: [
        { name: "studio", hosts: ["studio.corp"], action: "issue", reasons: ["apply --renew-certificates re-issues every leaf"] },
      ],
    });
    const missing = planTls({ ca: observed.ca, leaves: {} }, STUDIO, NOW, { renewAll: true });
    expect(missing.leaves).toEqual([
      { name: "studio", hosts: ["studio.corp"], action: "issue", reasons: ["the certificate or its key is missing"] },
    ]);
  });

  test("a fresh install creates the CA and issues every leaf", () => {
    const desired = desiredTls(config());
    const plan = planTls({ ca: {}, leaves: {} }, desired, NOW);
    expect(plan.ca).toBe("create");
    expect(plan.leaves).toEqual(
      desired.leaves.map((leaf) => ({ ...leaf, action: "issue", reasons: ["the internal CA is new"] })),
    );
  });

  test("the internal CA is created even when no leaf comes from it", () => {
    const desired = desiredTls(
      config({
        tls: { mode: "external", caBundleFile: "/etc/pki/corp-ca.pem", external: { trustedProxies: ["192.0.2.10/32"] } },
        postgres: { mode: "external", external: { host: "db.corp", adminUser: "dba" } },
      }),
    );
    expect(desired.leaves).toEqual([]);
    expect(planTls({ ca: {}, leaves: {} }, desired, NOW)).toEqual({ ca: "create", leaves: [] });
  });

  test("a leaf issued for other hosts is re-issued, naming the hosts it misses", async () => {
    const leaf = await issueLeaf(ca, ["studio.corp"], NOW);
    const plan = planTls(
      { ca: { certPem: ca.certPem, keyPem: ca.keyPem }, leaves: { studio: leaf } },
      { caCommonName: "x", leaves: [{ name: "studio", hosts: ["studio.example.com", "studio.corp", "10.0.0.5"] }] },
      NOW,
    );
    expect(plan.leaves).toEqual([
      {
        name: "studio",
        hosts: ["studio.example.com", "studio.corp", "10.0.0.5"],
        action: "issue",
        reasons: ["does not cover studio.example.com, 10.0.0.5"],
      },
    ]);
  });

  test("a missing leaf, a leaf without its key, a key that does not match, a leaf from another CA and an unreadable leaf are re-issued", async () => {
    const leaf = await issueLeaf(ca, ["studio.corp"], NOW);
    const other = await issueLeaf(ca, ["studio.corp"], NOW);
    const foreignCa = await createCa({ commonName: "other CA", now: at(-1) });
    const foreign = await issueLeaf(foreignCa, ["studio.corp"], NOW);
    const caMaterial = { certPem: ca.certPem, keyPem: ca.keyPem };
    const reasons = (observed: { certPem?: string; keyPem?: string } | undefined) => {
      const leaves = observed === undefined ? {} : { studio: observed };
      const [plan] = planTls({ ca: caMaterial, leaves }, STUDIO, NOW).leaves;
      if (plan?.action !== "issue") throw new Error(`expected issue, got ${JSON.stringify(plan)}`);
      return plan.reasons;
    };
    expect(reasons(undefined)).toEqual(["the certificate or its key is missing"]);
    expect(reasons({ certPem: leaf.certPem })).toEqual(["the certificate or its key is missing"]);
    expect(reasons({ keyPem: leaf.keyPem })).toEqual(["the certificate or its key is missing"]);
    expect(reasons({ certPem: leaf.certPem, keyPem: other.keyPem })).toEqual(["the key does not match the certificate"]);
    expect(reasons(foreign)).toEqual([
      "does not chain to the internal CA: no certificate in the chain or the CA bundle issued CN=studio.corp",
    ]);
    expect(reasons({ certPem: "garbage", keyPem: leaf.keyPem })).toEqual([
      "unreadable: the studio leaf: no PEM certificate found",
    ]);
    expect(reasons({ certPem: leaf.certPem, keyPem: "garbage" })).toEqual([
      "unreadable: the studio leaf key: not a valid unencrypted PEM private key",
    ]);
  });

  test("lists every reason that applies to one leaf", async () => {
    const foreignCa = await createCa({ commonName: "other CA", now: at(-900) });
    const foreign = await issueLeaf(foreignCa, ["platform.corp"], at(-820));
    const observed = { ca: { certPem: ca.certPem, keyPem: ca.keyPem }, leaves: { studio: foreign } };
    const [plan] = planTls(observed, STUDIO, NOW).leaves;
    expect(plan).toEqual({
      name: "studio",
      hosts: ["studio.corp"],
      action: "issue",
      reasons: [
        "does not cover studio.corp",
        "does not chain to the internal CA: no certificate in the chain or the CA bundle issued CN=platform.corp",
        "5 days left, fewer than 30",
      ],
    });
  });

  test("never replaces a present CA: half of a CA or a CA whose key does not match is refused", async () => {
    const otherCa = await createCa({ commonName: "other CA", now: at(-1) });
    expect(tlsError(() => planTls({ ca: { certPem: ca.certPem }, leaves: {} }, STUDIO, NOW)).message).toBe(
      "the internal CA certificate is present but its private key is missing; restore both from a backup, because the installer never replaces a present CA",
    );
    expect(tlsError(() => planTls({ ca: { keyPem: ca.keyPem }, leaves: {} }, STUDIO, NOW)).message).toBe(
      "the internal CA private key is present but its certificate is missing; restore both from a backup, because the installer never replaces a present CA",
    );
    expect(tlsError(() => planTls({ ca: { certPem: ca.certPem, keyPem: otherCa.keyPem }, leaves: {} }, STUDIO, NOW)).message).toBe(
      "the private key of the CA CN=LibreDB internal CA (acme) does not match its certificate",
    );
  });

  test("an expired CA is refused instead of being replaced", async () => {
    const expired = await createCa({ commonName: "LibreDB internal CA (acme)", now: new Date("2016-10-01T00:00:00Z") });
    expect(tlsError(() => planTls({ ca: expired, leaves: {} }, STUDIO, NOW)).message).toBe(
      "the CA CN=LibreDB internal CA (acme) is valid only from 2016-10-01T00:00:00.000Z to 2026-10-01T00:00:00.000Z, so it cannot issue a certificate at 2026-10-15T12:00:00.000Z",
    );
  });
});

describe("desiredTls", () => {
  test("generated TLS in Docker mode wants one leaf per public host and one for the PostgreSQL service postgres", () => {
    expect(desiredTls(config())).toEqual({
      caCommonName: "LibreDB internal CA (acme)",
      leaves: [
        { name: "platform", hosts: ["platform.corp"] },
        { name: "studio", hosts: ["studio.corp"] },
        { name: "auth", hosts: ["auth.corp"] },
        { name: "postgres", hosts: ["postgres"] },
      ],
    });
  });

  test("Kubernetes mode names the PostgreSQL service with every in-cluster name of its namespace", () => {
    const desired = desiredTls(config({ mode: "kubernetes", kubernetes: { namespace: "data-tier" } }));
    expect(desired.leaves.at(-1)).toEqual({
      name: "postgres",
      hosts: [
        "libredb-postgres",
        "libredb-postgres.data-tier",
        "libredb-postgres.data-tier.svc",
        "libredb-postgres.data-tier.svc.cluster.local",
      ],
    });
  });

  test("provided and external TLS keep only the PostgreSQL leaf from the internal CA", () => {
    const pair = (name: string) => ({ certificateFile: `/etc/pki/${name}.crt`, keyFile: `/etc/pki/${name}.key` });
    const provided = { platform: pair("platform"), studio: pair("studio"), auth: pair("auth") };
    for (const tls of [
      { mode: "provided", caBundleFile: "/etc/pki/corp-ca.pem", provided },
      { mode: "external", caBundleFile: "/etc/pki/corp-ca.pem", external: { trustedProxies: ["192.0.2.10/32"] } },
    ]) {
      expect(desiredTls(config({ tls })).leaves).toEqual([{ name: "postgres", hosts: ["postgres"] }]);
    }
  });

  test("an external PostgreSQL drops the PostgreSQL leaf and an external Keycloak drops the auth leaf", () => {
    const keycloak = {
      mode: "external",
      external: { baseUrl: "https://auth.corp", adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD" },
    };
    expect(desiredTls(config({ postgres: { mode: "external", external: { host: "db.corp", adminUser: "dba" } }, keycloak })).leaves).toEqual([
      { name: "platform", hosts: ["platform.corp"] },
      { name: "studio", hosts: ["studio.corp"] },
    ]);
  });
});
