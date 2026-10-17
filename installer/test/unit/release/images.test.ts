import { describe, expect, test } from "bun:test";
import { effectiveImages, imageReference } from "../../../src/release/images";
import { manifestFixture } from "./fixture";

const digest = (char: string) => `sha256:${char.repeat(64)}`;

describe("images", () => {
  test("rewrites studio to harbor.corp/libredb/libredb-studio@sha256:<digest> for registry harbor.corp/libredb", () => {
    const studio = { repository: "ghcr.io/libredb/libredb-studio", version: "1.0.0", digest: digest("b") };
    expect(imageReference(studio, "harbor.corp/libredb")).toBe(`harbor.corp/libredb/libredb-studio@${digest("b")}`);
  });

  test("keeps the upstream repository by digest when no mirror is configured", () => {
    const keycloak = { repository: "quay.io/keycloak/keycloak", version: "26.8.1", digest: digest("c") };
    expect(imageReference(keycloak, undefined)).toBe(`quay.io/keycloak/keycloak@${digest("c")}`);
  });

  test("lists every image in manifest order, rewritten for a mirror", () => {
    expect(effectiveImages(manifestFixture(), "registry.example.com/libredb")).toEqual([
      { name: "platform", reference: `registry.example.com/libredb/libredb-platform@${digest("1")}` },
      { name: "studio", reference: `registry.example.com/libredb/libredb-studio@${digest("2")}` },
      { name: "keycloak", reference: `registry.example.com/libredb/keycloak@${digest("3")}` },
      { name: "postgres", reference: `registry.example.com/libredb/postgres@${digest("4")}` },
      { name: "edge", reference: `registry.example.com/libredb/caddy@${digest("5")}` },
    ]);
  });
});
