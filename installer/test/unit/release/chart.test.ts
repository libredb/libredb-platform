import { describe, expect, test } from "bun:test";
import { chartDownloadUrl, chartFileName, chartSource } from "../../../src/release/chart";
import { manifestFixture } from "./fixture";

const index = `apiVersion: v1
entries:
  libredb-studio:
    - version: 0.1.92
      urls:
        - https://github.com/libredb/libredb-studio/releases/download/libredb-studio-0.1.92/libredb-studio-0.1.92.tgz
    - version: 0.1.91
      urls:
        - charts/libredb-studio-0.1.91.tgz
    - version: 0.1.90
`;

describe("studio chart", () => {
  test("a released chart comes from the chart repository", () => {
    const chart = manifestFixture().studioChart;
    expect(chartSource(chart)).toEqual({ kind: "repository", version: "0.1.92" });
    expect(chartFileName(chart)).toBe("libredb-studio-0.1.92.tgz");
  });

  test("a git:<sha> chart is a build of that Studio commit", () => {
    const chart = { ...manifestFixture().studioChart, version: `git:${"a".repeat(40)}` };
    expect(chartSource(chart)).toEqual({ kind: "git", commit: "a".repeat(40) });
    expect(chartFileName(chart)).toBe(`libredb-studio-git-${"a".repeat(40)}.tgz`);
  });

  test("finds an absolute download URL in the repository index", () => {
    expect(chartDownloadUrl(index, "https://libredb.org/libredb-studio/", "libredb-studio", "0.1.92")).toBe(
      "https://github.com/libredb/libredb-studio/releases/download/libredb-studio-0.1.92/libredb-studio-0.1.92.tgz",
    );
  });

  test("resolves a relative download URL against the repository URL", () => {
    expect(chartDownloadUrl(index, "https://libredb.org/libredb-studio", "libredb-studio", "0.1.91")).toBe(
      "https://libredb.org/libredb-studio/charts/libredb-studio-0.1.91.tgz",
    );
  });

  test("refuses a chart or version the index does not publish", () => {
    const repo = "https://libredb.org/libredb-studio/";
    expect(() => chartDownloadUrl(index, repo, "other", "1.0.0")).toThrow(`the chart repository ${repo} has no chart named other`);
    expect(() => chartDownloadUrl(index, repo, "libredb-studio", "9.9.9")).toThrow(
      `the chart repository ${repo} has no libredb-studio version 9.9.9`,
    );
    expect(() => chartDownloadUrl(index, repo, "libredb-studio", "0.1.90")).toThrow(
      `the chart repository ${repo} lists libredb-studio 0.1.90 without a URL`,
    );
    expect(() => chartDownloadUrl("[]", repo, "libredb-studio", "0.1.92")).toThrow("has no chart named libredb-studio");
  });
});
