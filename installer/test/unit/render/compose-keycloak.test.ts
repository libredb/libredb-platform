import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { KEYCLOAK_ENV_FILE, renderCompose } from "../../../src/render/compose";
import { publishedPorts } from "../../../src/preflight/docker-checks";
import { EXTERNAL_KEYCLOAK_SETS } from "../keycloak/fixture";
import { desiredFixture, TRUST_FIXTURE } from "./fixture";

interface ComposeDocument {
  services: Record<string, Record<string, unknown>>;
}

function keycloakService(sets: readonly string[] = []): Record<string, unknown> {
  const service = (parse(renderCompose(desiredFixture(sets), TRUST_FIXTURE)) as ComposeDocument).services.keycloak;
  if (service === undefined) throw new Error("the rendered compose file has no keycloak service");
  return service;
}

describe("renderCompose keycloak", () => {
  test("the keycloak service sets KC_DB_POOL_MAX_SIZE=20 and KC_TRUSTSTORE_PATHS and publishes 8080 only on 127.0.0.1", () => {
    const keycloak = keycloakService();
    const environment = keycloak.environment as Record<string, string>;
    expect(environment.KC_DB_POOL_MAX_SIZE).toBe("20");
    expect(environment.KC_TRUSTSTORE_PATHS).toBe("/etc/libredb/ca/ca.crt");
    expect(keycloak.ports).toEqual([{ target: 8080, host_ip: "127.0.0.1", published: "18080", protocol: "tcp" }]);
  });

  test("keycloak turns off the analytics of its Liquibase, which would call config.liquibase.com (R11)", () => {
    const environment = keycloakService().environment as Record<string, string>;
    expect(environment.LIQUIBASE_ANALYTICS_ENABLED).toBe("false");
  });

  test("keycloak runs start against database keycloak over verify-full TLS as libredb_keycloak, behind the edge", () => {
    const keycloak = keycloakService();
    expect(keycloak.image).toBe(desiredFixture().images.keycloak);
    expect(keycloak.image).toMatch(/^quay\.io\/keycloak\/keycloak@sha256:[0-9a-f]{64}$/);
    expect(keycloak.command).toEqual(["start"]);
    expect(keycloak.environment).toEqual({
      KC_DB: "postgres",
      KC_DB_URL:
        "jdbc:postgresql://postgres:5432/keycloak?sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt",
      KC_DB_USERNAME: "libredb_keycloak",
      KC_DB_POOL_MAX_SIZE: "20",
      KC_HOSTNAME: "https://auth.libredb.test",
      KC_HOSTNAME_ADMIN: "http://127.0.0.1:18080",
      KC_PROXY_HEADERS: "xforwarded",
      KC_HTTP_ENABLED: "true",
      KC_HEALTH_ENABLED: "true",
      KC_TRUSTSTORE_PATHS: "/etc/libredb/ca/ca.crt",
      LIQUIBASE_ANALYTICS_ENABLED: "false",
    });
    expect(keycloak.env_file).toEqual([{ path: KEYCLOAK_ENV_FILE, required: false }]);
    expect(KEYCLOAK_ENV_FILE).toBe("/opt/libredb/env/keycloak.env");
    expect(keycloak.volumes).toEqual(["/opt/libredb/ca:/etc/libredb/ca:ro"]);
    expect(keycloak.networks).toEqual({ edge: {}, data: {} });
    expect(keycloak.restart).toBe("unless-stopped");
  });

  test("the keycloak healthcheck asks /health/ready on the management port 9000", () => {
    const healthcheck = keycloakService().healthcheck as { test: string[] };
    expect(healthcheck.test.slice(0, 3)).toEqual(["CMD", "bash", "-c"]);
    expect(healthcheck.test[3]).toContain("/dev/tcp/127.0.0.1/9000");
    expect(healthcheck.test[3]).toContain("GET /health/ready ");
    // Compose interpolates $ in the file, so the command must not use one.
    expect(healthcheck.test[3]).not.toContain("$");
  });

  test("keycloak.adminPort moves the loopback port and the admin hostname together", () => {
    const keycloak = keycloakService(["keycloak.adminPort=28080"]);
    expect(keycloak.ports).toEqual([{ target: 8080, host_ip: "127.0.0.1", published: "28080", protocol: "tcp" }]);
    expect((keycloak.environment as Record<string, string>).KC_HOSTNAME_ADMIN).toBe("http://127.0.0.1:28080");
    expect(publishedPorts(renderCompose(desiredFixture(["keycloak.adminPort=28080"]), TRUST_FIXTURE))).toEqual([443, 28080]);
  });

  test("no bootstrap credential is rendered into compose.yaml", () => {
    expect(renderCompose(desiredFixture(), TRUST_FIXTURE)).not.toContain("KC_BOOTSTRAP");
  });

  test("an external Keycloak renders no keycloak service and publishes only 443", () => {
    const text = renderCompose(desiredFixture(EXTERNAL_KEYCLOAK_SETS), TRUST_FIXTURE);
    expect((parse(text) as ComposeDocument).services.keycloak).toBeUndefined();
    expect(publishedPorts(text)).toEqual([443]);
  });
});
