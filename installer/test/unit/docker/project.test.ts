import { describe, expect, test } from "bun:test";
import {
  composeImages,
  composeNetworks,
  NetworkConflictError,
  planNetworks,
  serviceDefinition,
} from "../../../src/docker/project";
import { renderCompose } from "../../../src/render/compose";
import { desiredFixture, TRUST_FIXTURE } from "../render/fixture";

const compose = renderCompose(desiredFixture(), TRUST_FIXTURE);

describe("compose project", () => {
  test("lists the image of every service once", () => {
    // platform and platform-migrate run the same Platform image, which is listed once.
    expect(composeImages(compose)).toEqual([
      `docker.io/library/caddy@sha256:${"5".repeat(64)}`,
      `docker.io/library/postgres@sha256:${"4".repeat(64)}`,
      `quay.io/keycloak/keycloak@sha256:${"3".repeat(64)}`,
      `ghcr.io/libredb/libredb-platform@sha256:${"1".repeat(64)}`,
      `ghcr.io/libredb/libredb-studio@sha256:${"2".repeat(64)}`,
    ]);
    expect(composeImages("services:\n  a:\n    image: x\n  b:\n    image: x\n")).toEqual(["x"]);
    expect(composeImages("name: empty\n")).toEqual([]);
  });

  test("refuses a service without an image", () => {
    expect(() => composeImages("services:\n  a: {}\n")).toThrow("service a has no image");
  });

  test("returns one service's definition and refuses an unknown one", () => {
    expect(serviceDefinition(compose, "postgres")).toMatchObject({ networks: { data: {} } });
    expect(() => serviceDefinition(compose, "mailer")).toThrow("no service mailer");
  });

  test("names the networks as Compose does, with the internal flag", () => {
    expect(composeNetworks(compose)).toEqual([
      { key: "edge", name: "libredb_edge", internal: false },
      { key: "data", name: "libredb_data", internal: true },
    ]);
    expect(composeNetworks("name: x\n", "x")).toEqual([]);
  });
});

describe("planNetworks", () => {
  const desired = composeNetworks(compose);
  const labels = (key: string) => ({ "com.docker.compose.project": "libredb", "com.docker.compose.network": key });

  test("creates the missing networks with the Compose labels", () => {
    expect(planNetworks(desired, [{ name: "libredb_edge", internal: false, labels: labels("edge") }])).toEqual([
      {
        kind: "network",
        network: { key: "data", name: "libredb_data", internal: true },
        labels: labels("data"),
        summary: "create internal network libredb_data",
      },
    ]);
    expect(planNetworks(desired, [])[0]?.summary).toBe("create network libredb_edge");
  });

  test("plans nothing when both networks exist as the project's", () => {
    const observed = desired.map((network) => ({ ...network, labels: labels(network.key) }));
    expect(planNetworks(desired, observed)).toEqual([]);
  });

  test("refuses a network of another owner or with another internal flag", () => {
    expect(() => planNetworks(desired, [{ name: "libredb_edge", internal: false, labels: {} }])).toThrow(
      NetworkConflictError,
    );
    expect(() =>
      planNetworks(desired, [{ name: "libredb_data", internal: false, labels: labels("data") }]),
    ).toThrow("internal false, and the installation needs internal true");
  });
});
