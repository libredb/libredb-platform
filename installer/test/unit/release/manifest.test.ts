import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReleaseManifestError, parseReleaseManifest } from "../../../src/release/manifest";
import { manifestFixture } from "./fixture";

function issuesOf(raw: unknown): string[] {
  try {
    parseReleaseManifest(raw);
  } catch (error) {
    if (error instanceof ReleaseManifestError) return error.issues;
    throw error;
  }
  throw new Error("expected the manifest to be refused");
}

describe("release manifest", () => {
  test("refuses an image entry without a sha256 digest or without a version", () => {
    const raw = manifestFixture() as unknown as { images: Record<string, Record<string, unknown>> };
    delete raw.images.studio!.digest;
    delete raw.images.keycloak!.version;
    raw.images.edge!.digest = "md5:0123";
    expect(issuesOf(raw)).toEqual([
      "images.studio.digest: every image is pinned by a sha256 digest, such as sha256:<64 hex>",
      "images.keycloak.version: every image declares its version",
      "images.edge.digest: every image is pinned by a sha256 digest, such as sha256:<64 hex>",
    ]);
  });

  test("refuses a missing image entry and an unknown one", () => {
    const raw = manifestFixture() as unknown as { images: Record<string, unknown> };
    delete raw.images.postgres;
    raw.images.redis = raw.images.edge;
    expect(issuesOf(raw)).toEqual(["images.postgres: missing image entry", 'images: Unrecognized key: "redis"']);
  });

  test("refuses an empty contract set and a chart without its sha256", () => {
    const raw = manifestFixture() as unknown as { contracts: { studioSupports: number[] }; studioChart: { sha256: string } };
    raw.contracts.studioSupports = [];
    raw.studioChart.sha256 = "sha256:abc";
    expect(issuesOf(raw)).toEqual([
      "studioChart.sha256: expected the 64 lowercase hex characters of a sha256",
      "contracts.studioSupports: expected at least one contract version",
    ]);
  });

  test("accepts a git build as a version, recorded as git:<sha>", () => {
    const raw = manifestFixture();
    raw.studioChart.version = `git:${"0".repeat(40)}`;
    expect(parseReleaseManifest(raw).studioChart.version).toBe(`git:${"0".repeat(40)}`);
  });

  test("requires studio.reportedVersion, the release version that the pinned Studio build reports", () => {
    const missing = manifestFixture() as unknown as { studio: Record<string, unknown> };
    delete missing.studio.reportedVersion;
    const message = "studio.reportedVersion: expected the version the pinned Studio build reports, such as 0.18.3";
    expect(issuesOf(missing)).toEqual([message]);

    const git = manifestFixture();
    git.studio.reportedVersion = `git:${"b".repeat(40)}`;
    expect(issuesOf(git)).toEqual([message]);
  });

  test("a Studio pinned as a release reports that release, and a git:<sha> pin records the version its build reports", () => {
    const raw = manifestFixture();
    expect(parseReleaseManifest(raw).studio.reportedVersion).toBe("0.18.3");

    raw.images.studio.version = "0.19.0";
    expect(issuesOf(raw)).toEqual([
      "studio.reportedVersion: Studio is pinned as release 0.19.0, which reports 0.19.0, not 0.18.3",
    ]);
    raw.studio.reportedVersion = "0.19.0";
    expect(parseReleaseManifest(raw).studio.reportedVersion).toBe("0.19.0");
  });

  test("the committed release config is valid and pins every image by digest", () => {
    const raw: unknown = JSON.parse(readFileSync(join(import.meta.dir, "../../../release/release.config.json"), "utf8"));
    const manifest = parseReleaseManifest(raw);
    expect(manifest.images.platform.repository).toBe("ghcr.io/libredb/libredb-platform");
    expect(manifest.version).toBe("1.2.0");
    expect(manifest.images.platform.version).toBe("1.1.0");
    expect(manifest.images.studio.version).toBe("1.1.0");
    expect(manifest.studioChart.version).toBe("0.1.103");
    expect(manifest.studio.reportedVersion).toBe("1.1.0");
    expect(manifest.images.keycloak.version).toBe("26.8.1");
    expect(manifest.images.postgres.version).toBe("18.6");
    // The "logout hint" test of e2e/interop.spec.ts passed against the pinned Keycloak.
    expect(manifest.studio.logoutHintVerified).toBe(true);
    expect(manifest.contracts).toEqual({ platformPublishes: [1], studioSupports: [1] });
  });

  test("the committed release config requires a Docker Engine that keeps ports published to 127.0.0.1 on the host", () => {
    const raw: unknown = JSON.parse(readFileSync(join(import.meta.dir, "../../../release/release.config.json"), "utf8"));
    // Before 28.0.0, hosts on the same L2 segment reach ports published to 127.0.0.1, such as the managed Keycloak's
    // keycloak.adminPort 127.0.0.1:18080. Preflight refuses 28.2.0 to 28.3.2 on its own (CVE-2025-54388), so the
    // minimum still admits 28.0.x and 28.1.x, such as the 28.0.4 of GitHub's ubuntu-24.04 runners.
    expect(parseReleaseManifest(raw).minimums.dockerEngine).toBe("28.0.0");
  });
});
