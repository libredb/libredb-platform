import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { renderCaddyfile } from "../../../src/render/caddyfile";
import { renderCompose } from "../../../src/render/compose";
import { composeTrust } from "../../../src/render/compose";
import { hostTrust } from "../../../src/steps/deploy";
import { desiredFixture, externalDesiredFixture, TRUST_FIXTURE } from "./fixture";

interface EdgeService {
  ports: { target: number; published: string; protocol: string }[];
  networks: { edge: { aliases?: string[] } | null };
  labels: Record<string, string>;
}

const edgeOf = (sets: string[], fixture = desiredFixture) =>
  (parse(renderCompose(fixture(sets), TRUST_FIXTURE)) as { services: { edge: EdgeService } }).services.edge;

describe("the edge in tls.mode external", () => {
  test("tls.mode external renders plain HTTP sites on tls.external.httpPort and an edge without network aliases", () => {
    const sets = ["tls.external.httpPort=8081"];
    const text = renderCaddyfile(externalDesiredFixture(sets));
    expect(text).toContain("\nhttp://platform.libredb.test:8081 {\n\treverse_proxy platform:3000\n}\n");
    expect(text).toContain("\nhttp://studio.libredb.test:8081 {\n\treverse_proxy studio:3000\n}\n");
    expect(text).toContain("\nhttp://auth.libredb.test:8081 {\n");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("\ttls ");

    const edge = edgeOf(sets, externalDesiredFixture);
    expect(edge.ports).toEqual([{ target: 8081, published: "8081", protocol: "tcp" }]);
    expect(edge.networks).toEqual({ edge: {} });
  });

  test("the HTTP port defaults to 8080", () => {
    expect(renderCaddyfile(externalDesiredFixture())).toContain("\nhttp://platform.libredb.test:8080 {\n");
    expect(edgeOf([], externalDesiredFixture).ports).toEqual([{ target: 8080, published: "8080", protocol: "tcp" }]);
  });

  test("the edge trusts the X-Forwarded headers only from the upstream proxy that tls.external.trustedProxies names", () => {
    const text = renderCaddyfile(externalDesiredFixture());
    expect(text.startsWith("{\n\tauto_https off\n\tservers {\n\t\ttrusted_proxies static 192.0.2.10/32\n\t}\n}\n")).toBe(
      true,
    );
  });

  test("the edge trusts every range of tls.external.trustedProxies", () => {
    const desired = externalDesiredFixture();
    const text = renderCaddyfile({ ...desired, edge: { ...desired.edge, trustedProxies: ["10.1.2.0/24", "192.0.2.7/32"] } });
    expect(text).toContain("\t\ttrusted_proxies static 10.1.2.0/24 192.0.2.7/32\n");
  });

  test("the auth site keeps the raw path guard and forwards only the realm and resource paths", () => {
    const text = renderCaddyfile(externalDesiredFixture());
    const auth = text.slice(text.indexOf("http://auth.libredb.test:8080 {"));
    expect(auth).toContain("\t@noncanonical vars_regexp {http.request.orig_uri}");
    expect(auth).toContain("\t@keycloak path /realms/libredb/* /resources/*\n");
  });

  test("the edge certificates do not count in the trust labels, because the upstream proxy holds them", () => {
    const desired = externalDesiredFixture();
    expect(hostTrust(desired).tlsSha256).toBe(composeTrust(undefined, []).tlsSha256);
  });
});

describe("the edge in tls.mode generated and provided", () => {
  test("serves TLS on 443 with every public hostname as a network alias and no trusted proxies", () => {
    for (const sets of [[], ["tls.mode=provided"]]) {
      const desired = desiredFixture(sets.length === 0 ? [] : providedSets());
      expect(desired.edge.scheme).toBe("https");
      expect(desired.edge.ports).toEqual([443]);
      expect(desired.edge.trustedProxies).toEqual([]);
      expect(renderCaddyfile(desired)).not.toContain("trusted_proxies");
      const edge = edgeOf(sets.length === 0 ? [] : providedSets());
      expect(edge.ports).toEqual([{ target: 443, published: "443", protocol: "tcp" }]);
      expect(edge.networks.edge?.aliases).toEqual(["platform.libredb.test", "studio.libredb.test", "auth.libredb.test"]);
    }
  });
});

function providedSets(): string[] {
  const sets = ["tls.mode=provided", "tls.caBundleFile=/etc/corp/ca.crt"];
  for (const endpoint of ["platform", "studio", "auth"]) {
    sets.push(`tls.provided.${endpoint}.certificateFile=/etc/corp/${endpoint}.crt`);
    sets.push(`tls.provided.${endpoint}.keyFile=/etc/corp/${endpoint}.key`);
  }
  return sets;
}
