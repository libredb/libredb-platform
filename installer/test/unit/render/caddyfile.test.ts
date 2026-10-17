import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CADDYFILE, NON_CANONICAL_PATH, renderCaddyfile } from "../../../src/render/caddyfile";
import { parse } from "yaml";
import { loadConfig } from "../../../src/config/load";
import { renderCompose } from "../../../src/render/compose";
import { desiredTls } from "../../../src/tls/plan";
import { EXTERNAL_KEYCLOAK_SETS } from "../keycloak/fixture";
import { desiredFixture, golden, portsDesiredFixture, TRUST_FIXTURE } from "./fixture";

const root = join(import.meta.dir, "..", "..", "..");

describe("renderCaddyfile", () => {
  test("the ports style renders one TLS site per port on one host with one leaf and one edge alias", () => {
    const desired = portsDesiredFixture();
    const files = "/etc/libredb/tls/lab.libredb.test.crt /etc/libredb/tls/lab.libredb.test.key";
    const text = renderCaddyfile(desired);
    expect(text).toBe(readFileSync(golden("Caddyfile-ports"), "utf8"));
    expect(text).toContain(`https://lab.libredb.test {\n\ttls ${files}\n\treverse_proxy platform:3000\n}\n`);
    expect(text).toContain(`https://lab.libredb.test:8443 {\n\ttls ${files}\n\treverse_proxy studio:3000\n}\n`);
    expect(text).toContain(`https://lab.libredb.test:9443 {\n\ttls ${files}\n`);
    expect(text.match(/^https:\/\//gm)).toHaveLength(3);

    const config = loadConfig({ file: join(root, "test", "fixtures", "configs", "docker-ports.yaml"), sets: [] });
    expect(desiredTls(config).leaves).toEqual([
      { name: "edge", hosts: ["lab.libredb.test"] },
      { name: "postgres", hosts: ["postgres"] },
    ]);

    const edge = (parse(renderCompose(desired, TRUST_FIXTURE)) as {
      services: { edge: { ports: unknown[]; networks: { edge: { aliases: string[] } } } };
    }).services.edge;
    expect(edge.networks.edge.aliases).toEqual(["lab.libredb.test"]);
    // The edge listens inside its container on the published port numbers, so in-network calls to the public URLs
    // reach it unchanged.
    expect(edge.ports).toEqual([
      { target: 443, published: "443", protocol: "tcp" },
      { target: 8443, published: "8443", protocol: "tcp" },
      { target: 9443, published: "9443", protocol: "tcp" },
    ]);
  });

  test("renders one TLS site per hostname equal to test/golden/Caddyfile-hostnames", () => {
    expect(renderCaddyfile(desiredFixture())).toBe(readFileSync(golden("Caddyfile-hostnames"), "utf8"));
  });

  test("the auth site proxies only /realms/libredb/* and /resources/*", () => {
    const text = renderCaddyfile(desiredFixture());
    const auth = text.slice(text.indexOf("https://auth.libredb.test {"));
    const site = auth.slice(0, auth.indexOf("\n}\n") + 3);
    expect(site).toContain("\t@keycloak path /realms/libredb/* /resources/*\n");
    expect(site).toContain("\thandle @keycloak {\n\t\treverse_proxy keycloak:8080\n\t}\n");
    expect(site).toContain("\thandle {\n\t\trespond 404\n\t}\n");
    expect(site.match(/reverse_proxy/g)).toHaveLength(1);
  });

  test("the auth site answers 400 before the realm matcher for a raw path with .., ;, a backslash or an encoded dot, slash or backslash", () => {
    const text = renderCaddyfile(desiredFixture());
    const auth = text.slice(text.indexOf("https://auth.libredb.test {"));
    const guard = "\t@noncanonical vars_regexp {http.request.orig_uri} `^[^?]*(\\.\\.|;|\\\\|%2[eEfF]|%5[cC])`\n" +
      "\thandle @noncanonical {\n\t\trespond 400\n\t}\n";
    expect(auth).toContain(guard);
    expect(auth.indexOf("@noncanonical")).toBeLessThan(auth.indexOf("@keycloak"));
    // Only the auth site carries the guard.
    expect(text.match(/@noncanonical vars_regexp/g)).toHaveLength(1);

    const pattern = new RegExp(NON_CANONICAL_PATH);
    for (const path of [
      "/realms/libredb/..;/master/",
      "/realms/libredb/%2e%2e/master/",
      "/realms/libredb/..%2f..%2fadmin/",
      "/realms/libredb/%2E/x",
      "/realms/libredb/a%5cb",
      "/realms/libredb/a%5Cb",
      "/realms/libredb/a\\b",
      "/realms/libredb/a;jsessionid=1",
      "/realms/libredb/../master/",
    ]) {
      expect({ path, refused: pattern.test(path) }).toEqual({ path, refused: true });
    }
    for (const path of [
      "/realms/libredb/.well-known/openid-configuration",
      "/realms/libredb/protocol/openid-connect/auth?client_id=libredb-studio&redirect_uri=https%3A%2F%2Fstudio.libredb.test%2Fx",
      "/realms/libredb/x?state=..;",
      "/resources/abc/login/keycloak.v2/css/styles.css",
    ]) {
      expect({ path, refused: pattern.test(path) }).toEqual({ path, refused: false });
    }
  });

  test("the auth site follows keycloak.realm", () => {
    expect(renderCaddyfile(desiredFixture(["keycloak.realm=acme"]))).toContain(
      "\t@keycloak path /realms/acme/* /resources/*\n",
    );
  });

  test("an external Keycloak renders no auth site", () => {
    const text = renderCaddyfile(desiredFixture(EXTERNAL_KEYCLOAK_SETS));
    expect(text).toContain("https://platform.libredb.test {");
    expect(text).not.toContain("auth.libredb.test");
  });

  test("the Caddyfile lives in the edge directory under /opt/libredb", () => {
    expect(CADDYFILE).toBe("/opt/libredb/edge/Caddyfile");
  });
});
