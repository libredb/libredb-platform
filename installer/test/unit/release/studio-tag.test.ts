import { describe, expect, test } from "bun:test";
import {
  chartAppVersion,
  manifestUrl,
  registryDigest,
  registryTag,
  studioPinProblems,
  studioTagVersion,
} from "../../../src/release/studio-tag";
import { manifestFixture } from "./fixture";

const PINNED = `git:${"b".repeat(40)}`;
const PINNED_DIGEST = `sha256:${"2".repeat(64)}`;

describe("studioPinProblems", () => {
  const agreeing = { studioTag: PINNED, chartAppVersion: PINNED, registryDigest: PINNED_DIGEST };

  test("accepts a release whose Studio pin equals STUDIO_TAG, the chart's app version and the registry digest", () => {
    expect(studioPinProblems(manifestFixture(), agreeing)).toEqual([]);
  });

  test("refuses a release config whose Studio version differs from tests/fixtures/governance/STUDIO_TAG, naming both", () => {
    const other = `git:${"c".repeat(40)}`;
    expect(studioPinProblems(manifestFixture(), { ...agreeing, studioTag: other })).toEqual([
      `the release pins Studio ${PINNED}, but Platform's tests/fixtures/governance/STUDIO_TAG names ${other}, so Platform would run with a Studio whose contract it did not vendor`,
    ]);
  });

  test("refuses an embedded chart whose appVersion differs from the pinned Studio version", () => {
    expect(studioPinProblems(manifestFixture(), { ...agreeing, chartAppVersion: "0.18.3" })).toEqual([
      `the pinned Studio chart deploys app version 0.18.3, but the release pins Studio ${PINNED}`,
    ]);
  });

  test("refuses a pinned digest that differs from the registry digest of the pinned version", () => {
    const reported = `sha256:${"9".repeat(64)}`;
    expect(studioPinProblems(manifestFixture(), { ...agreeing, registryDigest: reported })).toEqual([
      `the release pins Studio ${PINNED} at ${PINNED_DIGEST}, but the registry reports ${reported} for that version`,
    ]);
  });
});

describe("studioTagVersion", () => {
  test("drops a leading v and the trailing newline", () => {
    expect(studioTagVersion("v0.19.0\n")).toBe("0.19.0");
    expect(studioTagVersion(`${PINNED}\n`)).toBe(PINNED);
  });

  test("refuses anything but one release tag or git:<40 hex> on one line", () => {
    for (const text of ["", "\n", "latest\n", "v0.19.0\nv0.19.1\n", "git:abc\n"]) {
      expect(() => studioTagVersion(text)).toThrow(
        "STUDIO_TAG must hold one Studio release tag such as v0.19.0, or git:<40 hex>, on one line",
      );
    }
  });
});

describe("chartAppVersion", () => {
  test("a chart built from a Studio commit deploys the app of that commit", () => {
    const chart = { ...manifestFixture().studioChart, version: PINNED };
    expect(chartAppVersion(chart, undefined)).toBe(PINNED);
  });

  test("a released chart deploys the appVersion of its Chart.yaml", () => {
    expect(chartAppVersion(manifestFixture().studioChart, 'apiVersion: v2\nname: libredb-studio\nappVersion: "0.19.0"\n')).toBe(
      "0.19.0",
    );
  });

  test("a released chart needs its Chart.yaml with an appVersion", () => {
    const chart = manifestFixture().studioChart;
    expect(() => chartAppVersion(chart, undefined)).toThrow("the Studio chart 0.1.92 needs its Chart.yaml");
    expect(() => chartAppVersion(chart, "name: libredb-studio\n")).toThrow(
      "the Chart.yaml of the Studio chart 0.1.92 declares no appVersion",
    );
  });
});

describe("registry lookups", () => {
  test("a git build is tagged git-<sha> and a release by its version", () => {
    expect(registryTag(PINNED)).toBe(`git-${"b".repeat(40)}`);
    expect(registryTag("0.19.0")).toBe("0.19.0");
  });

  test("the manifest URL uses the upstream repository, or the mirror with the last path segment", () => {
    const { studio } = manifestFixture().images;
    expect(manifestUrl(studio, undefined)).toBe(
      `https://ghcr.io/v2/libredb/libredb-studio/manifests/git-${"b".repeat(40)}`,
    );
    expect(manifestUrl(studio, "registry.example.com/libredb")).toBe(
      `https://registry.example.com/v2/libredb/libredb-studio/manifests/git-${"b".repeat(40)}`,
    );
    expect(manifestUrl({ ...studio, version: "0.19.0" }, "localhost:5000")).toBe(
      "http://localhost:5000/v2/libredb-studio/manifests/0.19.0",
    );
    expect(manifestUrl({ ...studio, repository: "docker.io/library/postgres", version: "18.6" }, undefined)).toBe(
      "https://registry-1.docker.io/v2/library/postgres/manifests/18.6",
    );
  });

  const URL_ = "https://ghcr.io/v2/libredb/libredb-studio/manifests/0.19.0";

  test("reads Docker-Content-Digest from a HEAD of the manifest that accepts indexes and manifests", async () => {
    const seen: { url: string; method: string | undefined; accept: string | null }[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method, accept: new Headers(init?.headers).get("accept") });
      return new Response(null, { status: 200, headers: { "docker-content-digest": PINNED_DIGEST } });
    };
    expect(await registryDigest(URL_, fetcher)).toBe(PINNED_DIGEST);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("HEAD");
    expect(seen[0]?.accept).toContain("application/vnd.oci.image.index.v1+json");
    expect(seen[0]?.accept).toContain("application/vnd.docker.distribution.manifest.v2+json");
  });

  test("answers a Bearer challenge with an anonymous pull token and asks again", async () => {
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
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:libredb/libredb-studio:pull"',
          },
        });
      }
      return new Response(null, { status: 200, headers: { "docker-content-digest": PINNED_DIGEST } });
    };
    expect(await registryDigest(URL_, fetcher)).toBe(PINNED_DIGEST);
    expect(seen).toEqual([
      `HEAD ${URL_} -`,
      "GET https://ghcr.io/token?service=ghcr.io&scope=repository%3Alibredb%2Flibredb-studio%3Apull -",
      `HEAD ${URL_} Bearer anonymous-token`,
    ]);
  });

  test("accepts a token answer that names it access_token", async () => {
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://auth.example/")) return Response.json({ access_token: "t" });
      if (new Headers(init?.headers).get("authorization") === null) {
        return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.example/token"' } });
      }
      return new Response(null, { status: 200, headers: { "docker-content-digest": PINNED_DIGEST } });
    };
    expect(await registryDigest(URL_, fetcher)).toBe(PINNED_DIGEST);
  });

  test("names the URL and the status when the registry does not answer with a digest", async () => {
    const notFound = async () => new Response(null, { status: 404, statusText: "Not Found" });
    await expect(registryDigest(URL_, notFound)).rejects.toThrow(`HEAD ${URL_} answered 404 Not Found`);

    const noDigest = async () => new Response(null, { status: 200 });
    await expect(registryDigest(URL_, noDigest)).rejects.toThrow(`HEAD ${URL_} answered without a sha256 Docker-Content-Digest`);

    const unchallenged = async () => new Response(null, { status: 401, statusText: "Unauthorized" });
    await expect(registryDigest(URL_, unchallenged)).rejects.toThrow(`HEAD ${URL_} answered 401 Unauthorized`);

    const deniedToken = async (input: string | URL | Request) =>
      String(input).startsWith("https://auth.example/")
        ? new Response(null, { status: 403, statusText: "Forbidden" })
        : new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.example/token"' } });
    await expect(registryDigest(URL_, deniedToken)).rejects.toThrow("GET https://auth.example/token answered 403 Forbidden");

    const tokenless = async (input: string | URL | Request) =>
      String(input).startsWith("https://auth.example/")
        ? Response.json({})
        : new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.example/token"' } });
    await expect(registryDigest(URL_, tokenless)).rejects.toThrow("GET https://auth.example/token answered without a token");
  });
});
