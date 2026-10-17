import { beforeAll, describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  CA_SHA256_LABEL,
  TLS_SHA256_LABEL,
  composeTrust,
  renderCompose,
  type ComposeTrust,
} from "../../../src/render/compose";
import { buildCaBundle } from "../../../src/tls/bundle";
import { createCa, type CertificateAuthority } from "../../../src/tls/ca";
import { issueLeaf } from "../../../src/tls/leaf";
import { desiredFixture } from "./fixture";

type Services = Record<string, { labels?: Record<string, string> } & Record<string, unknown>>;

const NOW = new Date("2026-10-15T12:00:00Z");
const HOSTS = ["platform.libredb.test", "studio.libredb.test", "auth.libredb.test"];

let internal: CertificateAuthority;
let customer: CertificateAuthority;
let leaves: string[];

beforeAll(async () => {
  internal = await createCa({ commonName: "LibreDB internal CA (e2e)", now: NOW });
  customer = await createCa({ commonName: "Acme root CA", now: NOW });
  leaves = await Promise.all(HOSTS.map(async (host) => (await issueLeaf(internal, [host], NOW)).certPem));
});

function services(trust: ComposeTrust): Services {
  return (parse(renderCompose(desiredFixture(), trust)) as { services: Services }).services;
}

const edgeCertificates = (pems: readonly string[]) => HOSTS.map((host, index) => ({ host, pem: pems[index] }));

describe("compose trust labels", () => {
  test("adding a caBundleFile changes org.libredb.ca-sha256 on platform, studio, keycloak and edge and on no other service", () => {
    const before = services(composeTrust(buildCaBundle(internal.certPem, []), edgeCertificates(leaves)));
    const withCustomer = buildCaBundle(internal.certPem, [{ source: "/etc/acme/ca.crt", pem: customer.certPem }]);
    const after = services(composeTrust(withCustomer, edgeCertificates(leaves)));

    const changed = Object.keys(after).filter((name) => JSON.stringify(after[name]) !== JSON.stringify(before[name]));
    expect(changed.sort()).toEqual(["edge", "keycloak", "platform", "studio"]);
    for (const name of changed) {
      const label = after[name]?.labels?.[CA_SHA256_LABEL];
      expect(label).toMatch(/^[0-9a-f]{64}$/);
      expect(label).not.toBe(before[name]?.labels?.[CA_SHA256_LABEL] as string);
      // Only the label differs, so Compose recreates the service for the new bundle and for nothing else.
      const { labels: _after, ...restAfter } = after[name] as Services[string];
      const { labels: _before, ...restBefore } = before[name] as Services[string];
      expect(restAfter).toEqual(restBefore);
    }
    expect(before.postgres?.labels).toBeUndefined();
    expect(before["platform-migrate"]?.labels).toBeUndefined();
  });

  test("a re-issued edge leaf changes org.libredb.tls-sha256 on edge only, and equal inputs give equal labels", async () => {
    const bundle = buildCaBundle(internal.certPem, []);
    const before = services(composeTrust(bundle, edgeCertificates(leaves)));
    expect(services(composeTrust(bundle, edgeCertificates(leaves)))).toEqual(before);
    const renewed = [...leaves];
    renewed[1] = (await issueLeaf(internal, [HOSTS[1] as string], NOW)).certPem;
    const after = services(composeTrust(bundle, edgeCertificates(renewed)));
    const changed = Object.keys(after).filter((name) => JSON.stringify(after[name]) !== JSON.stringify(before[name]));
    expect(changed).toEqual(["edge"]);
    expect(after.edge?.labels?.[TLS_SHA256_LABEL]).toMatch(/^[0-9a-f]{64}$/);
    expect(after.edge?.labels?.[TLS_SHA256_LABEL]).not.toBe(before.edge?.labels?.[TLS_SHA256_LABEL] as string);
    expect(Object.keys(after.platform?.labels ?? {})).toEqual([CA_SHA256_LABEL]);
  });

  test("material the TLS and base steps have not written yet is labelled none, and a missing leaf differs from a present one", () => {
    const empty = composeTrust(undefined, edgeCertificates([]));
    expect(empty).toEqual({ caSha256: "none", tlsSha256: "none" });
    const one = composeTrust(undefined, [{ host: HOSTS[0] as string, pem: leaves[0] }, { host: HOSTS[1] as string, pem: undefined }]);
    expect(one.caSha256).toBe("none");
    expect(one.tlsSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
