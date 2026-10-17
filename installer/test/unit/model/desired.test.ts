import { describe, expect, test } from "bun:test";
import { parseInstallation } from "../../../src/config/schema";
import { computeDesired } from "../../../src/model/desired";
import { manifestFixture } from "../release/fixture";

function config(overrides: Record<string, unknown> = {}) {
  return parseInstallation({
    apiVersion: "install.libredb.org/v1",
    kind: "LibreDBInstallation",
    metadata: { name: "acme" },
    mode: "docker",
    endpoints: {
      hosts: { platform: "platform.example.com", studio: "studio.example.com", auth: "auth.example.com" },
    },
    platform: { organizationName: "Acme" },
    ...overrides,
  });
}

describe("computeDesired", () => {
  test("hosts platform.example.com, studio.example.com and auth.example.com give the issuer https://auth.example.com/realms/libredb and the redirect and post-logout URIs of both app clients", () => {
    const desired = computeDesired(config(), manifestFixture());
    expect(desired.urls).toEqual({
      platform: "https://platform.example.com",
      studio: "https://studio.example.com",
      auth: "https://auth.example.com",
    });
    expect(desired.issuer).toBe("https://auth.example.com/realms/libredb");
    expect(desired.clients).toEqual({
      studio: {
        redirectUri: "https://studio.example.com/api/auth/oidc/callback",
        postLogoutRedirectUri: "https://studio.example.com/login",
      },
      platform: {
        redirectUri: "https://platform.example.com/api/auth/callback/keycloak",
        postLogoutRedirectUri: "https://platform.example.com/login",
      },
    });
  });

  test("the issuer follows the configured realm", () => {
    const desired = computeDesired(config({ keycloak: { realm: "corp" } }), manifestFixture());
    expect(desired.realm).toBe("corp");
    expect(desired.issuer).toBe("https://auth.example.com/realms/corp");
  });

  test("the edge serves the three hostnames when Keycloak is managed, each proxied to its in-network service", () => {
    const desired = computeDesired(config(), manifestFixture());
    expect(desired.edge.sites).toEqual([
      { endpoint: "platform", host: "platform.example.com", port: 443, upstream: "platform:3000" },
      { endpoint: "studio", host: "studio.example.com", port: 443, upstream: "studio:3000" },
      { endpoint: "auth", host: "auth.example.com", port: 443, upstream: "keycloak:8080" },
    ]);
  });

  test("the edge does not serve the auth hostname when Keycloak is external, whose base URL gives the issuer", () => {
    const desired = computeDesired(
      config({
        keycloak: {
          mode: "external",
          realm: "corp",
          external: { baseUrl: "https://auth.example.com:8443/auth/", adminUser: "admin", adminPasswordEnv: "KC_PASSWORD" },
        },
      }),
      manifestFixture(),
    );
    expect(desired.edge.sites.map((site) => site.host)).toEqual(["platform.example.com", "studio.example.com"]);
    expect(desired.urls.auth).toBe("https://auth.example.com:8443/auth");
    expect(desired.issuer).toBe("https://auth.example.com:8443/auth/realms/corp");
  });

  test("images are pinned by digest, and rewritten to the configured registry mirror", () => {
    expect(computeDesired(config(), manifestFixture()).images.postgres).toBe(
      `docker.io/library/postgres@sha256:${"4".repeat(64)}`,
    );
    const mirrored = computeDesired(config({ images: { registry: "harbor.corp/libredb" } }), manifestFixture());
    expect(mirrored.images.edge).toBe(`harbor.corp/libredb/caddy@sha256:${"5".repeat(64)}`);
  });

  test("docker.systemdUnit is carried for Docker mode and is false in Kubernetes mode", () => {
    expect(computeDesired(config({ docker: { systemdUnit: true } }), manifestFixture()).systemdUnit).toBe(true);
    expect(computeDesired(config(), manifestFixture()).systemdUnit).toBe(false);
    expect(computeDesired(config({ mode: "kubernetes" }), manifestFixture()).systemdUnit).toBe(false);
  });

  test("the apps reach the managed PostgreSQL by its service on 5432, and an external one at its configured host and port", () => {
    expect(computeDesired(config(), manifestFixture()).postgres).toEqual({ managed: true, host: "postgres", port: 5432 });
    expect(computeDesired(config({ mode: "kubernetes" }), manifestFixture()).postgres).toEqual({
      managed: true,
      host: "libredb-postgres",
      port: 5432,
    });
    const external = computeDesired(
      config({ postgres: { mode: "external", external: { host: "pg.corp.example", port: 6432, adminUser: "dba" } } }),
      manifestFixture(),
    );
    expect(external.postgres).toEqual({ managed: false, host: "pg.corp.example", port: 6432 });
  });

  test("a managed Keycloak is reached on the loopback admin port, 18080 by default, and Platform on its service", () => {
    expect(computeDesired(config(), manifestFixture()).keycloak).toEqual({
      managed: true,
      adminPort: 18080,
      adminUrl: "http://127.0.0.1:18080",
      platformAdminUrl: "http://keycloak:8080",
    });
  });

  test("an external Keycloak is reached on keycloak.external.adminUrl, else on its base URL, and only the former reaches Platform", () => {
    const external = (fields: Record<string, unknown>) =>
      computeDesired(
        config({
          keycloak: {
            mode: "external",
            adminPort: 19090,
            external: { baseUrl: "https://auth.example.com", adminClientId: "provisioner", adminClientSecretFile: "/root/kc", ...fields },
          },
        }),
        manifestFixture(),
      ).keycloak;
    expect(external({})).toEqual({
      managed: false,
      adminPort: 19090,
      adminUrl: "https://auth.example.com",
      platformAdminUrl: undefined,
    });
    expect(external({ adminUrl: "https://sso-admin.corp.internal" })).toEqual({
      managed: false,
      adminPort: 19090,
      adminUrl: "https://sso-admin.corp.internal",
      platformAdminUrl: "https://sso-admin.corp.internal",
    });
  });

  test("ports style on lab.corp with 443, 8443 and 9443 gives Studio callback https://lab.corp:8443/api/auth/oidc/callback, issuer https://lab.corp:9443/realms/libredb and Platform callback https://lab.corp/api/auth/callback/keycloak", () => {
    const desired = computeDesired(
      config({ endpoints: { style: "ports", host: "lab.corp", ports: { platform: 443, studio: 8443, auth: 9443 } } }),
      manifestFixture(),
    );
    expect(desired.hosts).toEqual({ platform: "lab.corp", studio: "lab.corp", auth: "lab.corp" });
    expect(desired.urls).toEqual({
      platform: "https://lab.corp",
      studio: "https://lab.corp:8443",
      auth: "https://lab.corp:9443",
    });
    expect(desired.issuer).toBe("https://lab.corp:9443/realms/libredb");
    expect(desired.clients).toEqual({
      studio: {
        redirectUri: "https://lab.corp:8443/api/auth/oidc/callback",
        postLogoutRedirectUri: "https://lab.corp:8443/login",
      },
      platform: {
        redirectUri: "https://lab.corp/api/auth/callback/keycloak",
        postLogoutRedirectUri: "https://lab.corp/login",
      },
    });
    expect(desired.edge.sites).toEqual([
      { endpoint: "platform", host: "lab.corp", port: 443, upstream: "platform:3000" },
      { endpoint: "studio", host: "lab.corp", port: 8443, upstream: "studio:3000" },
      { endpoint: "auth", host: "lab.corp", port: 9443, upstream: "keycloak:8080" },
    ]);
  });

  test("the ports style defaults to 443 for Platform, 8443 for Studio and 9443 for Keycloak", () => {
    const desired = computeDesired(config({ endpoints: { style: "ports", host: "lab.corp" } }), manifestFixture());
    expect(desired.edge.sites.map((site) => site.port)).toEqual([443, 8443, 9443]);
  });

  test("a Platform port other than 443 stays in the Platform URL", () => {
    const desired = computeDesired(
      config({ endpoints: { style: "ports", host: "lab.corp", ports: { platform: 4443 } } }),
      manifestFixture(),
    );
    expect(desired.urls.platform).toBe("https://lab.corp:4443");
    expect(desired.clients.platform.redirectUri).toBe("https://lab.corp:4443/api/auth/callback/keycloak");
  });
});
