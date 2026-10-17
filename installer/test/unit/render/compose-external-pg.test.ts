import { describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";
import { composeNetworks } from "../../../src/docker/project";
import { composeExternalPostgres, keycloakJdbcUrl, renderCompose } from "../../../src/render/compose";
import { desiredFixture, TRUST_FIXTURE } from "./fixture";

interface ComposeDocument {
  services: Record<string, Record<string, unknown>>;
  networks: Record<string, Record<string, unknown>>;
  volumes: Record<string, unknown>;
  "x-libredb"?: unknown;
}

const EXTERNAL = [
  "postgres.mode=external",
  "postgres.external.host=pg.corp.example",
  "postgres.external.port=6432",
  "postgres.external.adminUser=corp_dba",
];

describe("renderCompose with an external PostgreSQL", () => {
  test("runs no postgres service and keeps no postgres volume, and network data routes to the external server", () => {
    const text = renderCompose(desiredFixture(EXTERNAL), TRUST_FIXTURE);
    const compose = parse(text) as ComposeDocument;
    expect(Object.keys(compose.services)).toEqual(["edge", "keycloak", "platform-migrate", "platform", "studio"]);
    expect(Object.keys(compose.volumes)).not.toContain("postgres-data");
    expect(compose.networks.data).toEqual({});
    expect(composeNetworks(text).find((network) => network.key === "data")).toEqual({
      key: "data",
      name: "libredb_data",
      internal: false,
    });
  });

  test("Keycloak's JDBC URL names the external server with verify-full and the CA bundle", () => {
    const compose = parse(renderCompose(desiredFixture(EXTERNAL), TRUST_FIXTURE)) as ComposeDocument;
    const environment = compose.services.keycloak?.environment as Record<string, string>;
    expect(environment.KC_DB_URL).toBe(
      "jdbc:postgresql://pg.corp.example:6432/keycloak?sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt",
    );
    expect(keycloakJdbcUrl({ managed: false, host: "db.corp", port: 5432 })).toBe(
      "jdbc:postgresql://db.corp:5432/keycloak?sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt",
    );
    const managed = parse(renderCompose(desiredFixture(), TRUST_FIXTURE)) as ComposeDocument;
    expect((managed.services.keycloak?.environment as Record<string, string>).KC_DB_URL).toBe(
      "jdbc:postgresql://postgres:5432/keycloak?sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt",
    );
  });

  test("records the external server and the psql image for db-shell, and a managed install records none", () => {
    const desired = desiredFixture(EXTERNAL);
    expect(composeExternalPostgres(renderCompose(desired, TRUST_FIXTURE))).toEqual({
      host: "pg.corp.example",
      port: 6432,
      psqlImage: desired.images.postgres,
    });
    expect(composeExternalPostgres(renderCompose(desiredFixture(), TRUST_FIXTURE))).toBeUndefined();
    expect("x-libredb" in (parse(renderCompose(desiredFixture(), TRUST_FIXTURE)) as ComposeDocument)).toBe(false);
  });

  test("refuses a recorded server without its host, port or psql image", () => {
    const broken = stringify({ name: "libredb", "x-libredb": { postgres: { host: "pg.corp.example", port: "6432" } } });
    expect(() => composeExternalPostgres(broken)).toThrow(
      "the x-libredb field of the compose file has no external PostgreSQL host, port and psql image",
    );
  });
});
