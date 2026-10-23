import { describe, expect, test } from "bun:test";
import { buildHelmJobs, committedBundle } from "../../../scripts/build-helm-jobs";

describe("the Helm chart's job bundle", () => {
  test("is the bundle of the installer's current code: run `bun run build:helm-jobs` after changing what the jobs import", () => {
    expect(committedBundle() === buildHelmJobs()).toBe(true);
  }, 60_000);
});
