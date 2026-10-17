import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { COMPOSE_FILE, renderCompose, renderPgHba } from "../../../src/render/compose";
import { EXTERNAL_KEYCLOAK_SETS } from "../keycloak/fixture";
import { desiredFixture, golden, TRUST_FIXTURE } from "./fixture";

interface ComposeDocument {
  name: string;
  services: Record<string, Record<string, unknown>>;
  networks: Record<string, Record<string, unknown>>;
  volumes: Record<string, unknown>;
}

describe("renderCompose", () => {
  test("renders the skeleton compose file equal to test/golden/compose-skeleton.yaml, with three edge aliases and an internal data network", () => {
    const text = renderCompose(desiredFixture(), TRUST_FIXTURE);
    expect(text).toBe(readFileSync(golden("compose-skeleton.yaml"), "utf8"));

    const compose = parse(text) as ComposeDocument;
    expect(compose.name).toBe("libredb");
    expect(compose.networks.data).toEqual({ internal: true });
    expect(compose.networks.edge).toEqual({});
    expect(compose.services.edge?.networks).toEqual({
      edge: { aliases: ["platform.libredb.test", "studio.libredb.test", "auth.libredb.test"] },
    });
    expect(compose.services.postgres?.networks).toEqual({ data: {} });
  });

  test("every long-running service restarts unless stopped, a job never restarts, and every service rotates its logs", () => {
    const compose = parse(renderCompose(desiredFixture(), TRUST_FIXTURE)) as ComposeDocument;
    for (const [name, service] of Object.entries(compose.services)) {
      const job = (service.profiles as string[] | undefined)?.includes("jobs") === true;
      expect({ name, restart: service.restart }).toEqual({ name, restart: job ? undefined : "unless-stopped" });
      expect(service.logging).toEqual({ driver: "json-file", options: { "max-size": "10m", "max-file": "5" } });
    }
  });

  test("postgres runs with ssl on and the rendered pg_hba.conf, and keeps its data in a named volume", () => {
    const postgres = (parse(renderCompose(desiredFixture(), TRUST_FIXTURE)) as ComposeDocument).services.postgres;
    expect(postgres?.command).toContain("ssl=on");
    expect(postgres?.command).toContain("hba_file=/etc/libredb/postgres/pg_hba.conf");
    expect(postgres?.volumes).toContain("postgres-data:/var/lib/postgresql");
  });

  test("an external Keycloak leaves the auth hostname off the edge aliases", () => {
    const compose = parse(renderCompose(desiredFixture(EXTERNAL_KEYCLOAK_SETS), TRUST_FIXTURE)) as ComposeDocument;
    expect(compose.services.edge?.networks).toEqual({
      edge: { aliases: ["platform.libredb.test", "studio.libredb.test"] },
    });
  });

  test("the compose file lives at /opt/libredb/compose.yaml", () => {
    expect(COMPOSE_FILE).toBe("/opt/libredb/compose.yaml");
  });
});

describe("renderPgHba", () => {
  test("accepts network connections only as hostssl, and every connection only with scram-sha-256", () => {
    const rules = renderPgHba()
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(rules).toEqual([
      "local all all scram-sha-256",
      "hostssl all all 0.0.0.0/0 scram-sha-256",
      "hostssl all all ::/0 scram-sha-256",
    ]);
  });
});
