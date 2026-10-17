import { describe, expect, test } from "bun:test";
import { checkContractCompat, findPreviousRelease } from "../../../src/release/compat";

describe("checkContractCompat", () => {
  test("refuses a release whose Platform no longer publishes a version that the previous Studio supports", () => {
    const problems = checkContractCompat(
      { platformPublishes: [2], studioSupports: [1, 2] },
      { platformPublishes: [1, 2], studioSupports: [1] },
    );
    expect(problems).toEqual([
      "Platform publishes [2] but the previous Studio supports only [1], so the previous Studio cannot run during an upgrade or after a Studio rollback",
    ]);
  });

  test("refuses a release whose Studio no longer supports a version that the previous Platform publishes", () => {
    const problems = checkContractCompat(
      { platformPublishes: [1, 2], studioSupports: [2] },
      { platformPublishes: [1], studioSupports: [1, 2] },
    );
    expect(problems).toEqual([
      "Studio supports [2] but the previous Platform publishes only [1], so Studio cannot run against a Platform restored to the previous release",
    ]);
  });

  test("accepts platformPublishes [1, 2] and studioSupports [1, 2] after a release with [1] and [1]", () => {
    expect(
      checkContractCompat({ platformPublishes: [1, 2], studioSupports: [1, 2] }, { platformPublishes: [1], studioSupports: [1] }),
    ).toEqual([]);
  });

  test("refuses a release whose own Platform and Studio share no version", () => {
    expect(checkContractCompat({ platformPublishes: [2], studioSupports: [1] }, null)).toEqual([
      "Platform publishes [2] and Studio supports [1] in this release, so they share no contract version",
    ]);
  });

  test("the first release has no previous release to check against", () => {
    expect(checkContractCompat({ platformPublishes: [1], studioSupports: [1] }, null)).toEqual([]);
  });
});

describe("findPreviousRelease", () => {
  test("picks the newest recorded version below the current one, comparing numerically", () => {
    expect(findPreviousRelease("1.10.0", ["1.2.0", "1.9.3", "1.10.0", "0.9.0"])).toBe("1.9.3");
  });

  test("returns undefined when nothing older is recorded", () => {
    expect(findPreviousRelease("1.0.0", [])).toBeUndefined();
    expect(findPreviousRelease("1.0.0", ["1.0.0"])).toBeUndefined();
  });

  test("refuses a history that holds a newer release than the current one", () => {
    expect(() => findPreviousRelease("1.0.0", ["0.9.0", "1.0.1"])).toThrow(
      "release/history holds 1.0.1, which is newer than the release version 1.0.0",
    );
  });

  test("refuses a version that is not MAJOR.MINOR.PATCH", () => {
    expect(() => findPreviousRelease("1.0", [])).toThrow("'1.0' is not a release version of the form MAJOR.MINOR.PATCH");
  });
});
