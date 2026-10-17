import type { ReleaseManifest } from "../../../src/release/manifest";

const digest = (char: string) => `sha256:${char.repeat(64)}`;

/** A valid release manifest with recognisable digests, as a fresh mutable object per call. */
export function manifestFixture(): ReleaseManifest {
  return {
    version: "1.0.0",
    images: {
      platform: { repository: "ghcr.io/libredb/libredb-platform", version: `git:${"a".repeat(40)}`, digest: digest("1") },
      studio: { repository: "ghcr.io/libredb/libredb-studio", version: `git:${"b".repeat(40)}`, digest: digest("2") },
      keycloak: { repository: "quay.io/keycloak/keycloak", version: "26.8.1", digest: digest("3") },
      postgres: { repository: "docker.io/library/postgres", version: "18.6", digest: digest("4") },
      edge: { repository: "docker.io/library/caddy", version: "2.11.7", digest: digest("5") },
    },
    studioChart: {
      name: "libredb-studio",
      version: "0.1.92",
      repository: "https://libredb.org/libredb-studio/",
      sha256: "f".repeat(64),
    },
    minimums: { dockerEngine: "24.0.0", compose: "2.24.0", kubernetes: "1.28.0" },
    studio: { logoutHintVerified: false, reportedVersion: "0.18.3" },
    contracts: { platformPublishes: [1], studioSupports: [1] },
  };
}
