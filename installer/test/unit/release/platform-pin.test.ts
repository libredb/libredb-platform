import { describe, expect, test } from "bun:test";
import { platformPinProblems } from "../../../src/release/platform-pin";
import { manifestFixture } from "./fixture";

const RELEASE_DIGEST = `sha256:${"1".repeat(64)}`;
const PLACEHOLDER = `sha256:${"0".repeat(64)}`;
const MAIN_BUILD_DIGEST = `sha256:${"7".repeat(64)}`;
const URL_ = "https://ghcr.io/v2/libredb/libredb-platform/manifests/1.0.0";

/** The release manifest fixture with Platform pinned as release 1.0.0 at the given digest. */
function pinned(digest: string) {
  const manifest = manifestFixture();
  manifest.images.platform = { repository: "ghcr.io/libredb/libredb-platform", version: "1.0.0", digest };
  return manifest;
}

/** A registry that reports the digest for every manifest it is asked about, recording each request. */
function reporting(digest: string) {
  const seen: { url: string; method: string | undefined }[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method });
    return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
  };
  return { seen, fetcher };
}

describe("platformPinProblems", () => {
  test("accepts a release whose Platform digest is the one the registry reports for the pinned version", async () => {
    const registry = reporting(RELEASE_DIGEST);
    expect(await platformPinProblems(pinned(RELEASE_DIGEST), undefined, registry.fetcher)).toEqual([]);
    expect(registry.seen).toEqual([{ url: URL_, method: "HEAD" }]);
  });

  test("refuses the placeholder digest and the digest of another build, such as a main build, naming both digests", async () => {
    for (const digest of [PLACEHOLDER, MAIN_BUILD_DIGEST]) {
      expect(await platformPinProblems(pinned(digest), undefined, reporting(RELEASE_DIGEST).fetcher)).toEqual([
        `the release pins Platform 1.0.0 at ${digest}, but the registry reports ${RELEASE_DIGEST} for that version`,
      ]);
    }
  });

  test("asks a registry mirror for the image's last path segment", async () => {
    const registry = reporting(RELEASE_DIGEST);
    expect(await platformPinProblems(pinned(RELEASE_DIGEST), "registry.example.com/libredb", registry.fetcher)).toEqual([]);
    expect(registry.seen).toEqual([
      { url: "https://registry.example.com/v2/libredb/libredb-platform/manifests/1.0.0", method: "HEAD" },
    ]);
  });

  test("answers the registry's Bearer challenge with an anonymous pull token", async () => {
    const seen: string[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      seen.push(`${init?.method ?? "GET"} ${url} ${authorization ?? "-"}`);
      if (url.startsWith("https://ghcr.io/token")) return Response.json({ token: "anonymous-token" });
      if (authorization === null) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:libredb/libredb-platform:pull"',
          },
        });
      }
      return new Response(null, { status: 200, headers: { "docker-content-digest": RELEASE_DIGEST } });
    };
    expect(await platformPinProblems(pinned(PLACEHOLDER), undefined, fetcher)).toEqual([
      `the release pins Platform 1.0.0 at ${PLACEHOLDER}, but the registry reports ${RELEASE_DIGEST} for that version`,
    ]);
    expect(seen).toEqual([
      `HEAD ${URL_} -`,
      "GET https://ghcr.io/token?service=ghcr.io&scope=repository%3Alibredb%2Flibredb-platform%3Apull -",
      `HEAD ${URL_} Bearer anonymous-token`,
    ]);
  });

  test("fails naming the URL and the status while the registry holds no image of the pinned version", async () => {
    const notFound = async () => new Response(null, { status: 404, statusText: "Not Found" });
    await expect(platformPinProblems(pinned(PLACEHOLDER), undefined, notFound)).rejects.toThrow(
      `HEAD ${URL_} answered 404 Not Found`,
    );
  });
});
