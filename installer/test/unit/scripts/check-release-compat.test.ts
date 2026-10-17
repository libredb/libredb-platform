import { describe, expect, test } from "bun:test";
import { CONFIG_PATH, readManifest, releaseCheckProblems, type StudioSources } from "../../../scripts/check-release-compat";
import type { ReleaseManifest } from "../../../src/release/manifest";
import { manifestUrl } from "../../../src/release/studio-tag";

const OTHER_DIGEST = `sha256:${"7".repeat(64)}`;

/** A STUDIO_TAG and a Chart.yaml that agree with the release's Studio pin, so only the registry can refuse the release. */
function agreeingStudio(release: ReleaseManifest): StudioSources {
  const version = release.images.studio.version;
  return { studioTag: `${version}\n`, chartYaml: `apiVersion: v2\nname: libredb-studio\nappVersion: "${version}"\n` };
}

/**
 * A registry, upstream or the mirror, that reports the pinned Studio digest and the given Platform digest, records
 * every request and answers 404 to any other.
 */
function stubRegistry(release: ReleaseManifest, platformDigest: string, mirror?: string) {
  const digests = new Map([
    [manifestUrl(release.images.studio, mirror), release.images.studio.digest],
    [manifestUrl(release.images.platform, mirror), platformDigest],
  ]);
  const asked: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? "GET"} ${url}`);
    const digest = digests.get(url);
    if (digest === undefined) return new Response(null, { status: 404, statusText: "Not Found" });
    return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
  };
  return { asked, fetcher };
}

describe("releaseCheckProblems", () => {
  test("refuses the committed release config while the registry reports another digest for its Platform version, as for the zero placeholder", async () => {
    const release = readManifest(CONFIG_PATH);
    const platform = release.images.platform;
    const registry = stubRegistry(release, OTHER_DIGEST);
    const { problems } = await releaseCheckProblems(release, agreeingStudio(release), undefined, registry.fetcher);
    expect(problems).toEqual([
      `the release pins Platform ${platform.version} at ${platform.digest}, but the registry reports ${OTHER_DIGEST} for that version`,
    ]);
    expect(registry.asked).toEqual([
      `HEAD ${manifestUrl(release.images.studio, undefined)}`,
      `HEAD ${manifestUrl(platform, undefined)}`,
    ]);
  });

  test("passes the committed release config when the registry reports the Platform digest it pins", async () => {
    const release = readManifest(CONFIG_PATH);
    const registry = stubRegistry(release, release.images.platform.digest);
    const { problems } = await releaseCheckProblems(release, agreeingStudio(release), undefined, registry.fetcher);
    expect(problems).toEqual([]);
  });

  test("asks a registry mirror for the Studio and the Platform digest", async () => {
    const release = readManifest(CONFIG_PATH);
    const mirror = "registry.example.com/libredb";
    const registry = stubRegistry(release, OTHER_DIGEST, mirror);
    const { problems } = await releaseCheckProblems(release, agreeingStudio(release), mirror, registry.fetcher);
    expect(problems).toHaveLength(1);
    expect(registry.asked).toEqual([
      `HEAD ${manifestUrl(release.images.studio, mirror)}`,
      `HEAD ${manifestUrl(release.images.platform, mirror)}`,
    ]);
    for (const request of registry.asked) expect(request).toStartWith("HEAD https://registry.example.com/v2/libredb/");
  });
});
