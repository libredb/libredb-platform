import { describe, expect, test } from "bun:test";
import { findCoverageFailures, parseLcov } from "../../../scripts/check-coverage";

const lcov = `TN:
SF:/repo/installer/src/config/schema.ts
DA:1,3
DA:2,0
end_of_record
TN:
SF:src/cli/main.ts
DA:1,0
end_of_record
TN:
SF:src/config/load.ts
DA:1,1
DA:2,5
end_of_record
`;

describe("check-coverage", () => {
  const report = parseLcov(lcov, "/repo/installer");

  test("a pure module below 100% fails with its line ratio", () => {
    expect(findCoverageFailures(["src/config/schema.ts"], report)).toEqual(["src/config/schema.ts: 50.00% lines (1/2)"]);
  });

  test("a pure module no unit test loads fails", () => {
    expect(findCoverageFailures(["src/config/defaults.ts"], report)).toEqual([
      "src/config/defaults.ts: not loaded by any unit test",
    ]);
  });

  test("adapters, steps and cli are exempt and a fully covered module passes", () => {
    expect(
      findCoverageFailures(
        ["src/cli/main.ts", "src/adapters/docker.ts", "src/steps/base.ts", "src/config/load.ts"],
        report,
      ),
    ).toEqual([]);
  });

  test("a malformed DA line raises an error", () => {
    expect(() => parseLcov("SF:src/a.ts\nDA:1,x\nend_of_record\n", "/repo")).toThrow("malformed lcov line");
  });
});
