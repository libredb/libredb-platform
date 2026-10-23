import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../../src/config/schema";
import { RefusedError } from "../../../src/kubernetes/bootstrap";
import { UnsafeChangeError } from "../../../src/state/immutable";

// The CLI module runs its job on import, so the exit code mapping is checked through a dynamic import guarded by an
// unknown command, which prints the usage and changes nothing.
describe("the jobs' exit code", () => {
  test("a refusal keeps the installer's exit code, anything else is a runtime failure", async () => {
    const argv = process.argv;
    const error = console.error;
    process.argv = [argv[0] as string, "job", "--help"];
    console.error = () => {};
    const { jobExitCode } = await import("../../../src/cli/kubernetes-job");
    process.argv = argv;
    console.error = error;
    process.exitCode = 0;
    expect(jobExitCode(new ConfigError(["x: bad"]))).toBe(2);
    expect(jobExitCode(new RefusedError("downgrade", 6))).toBe(6);
    expect(jobExitCode(new UnsafeChangeError([]))).toBe(6);
    expect(jobExitCode(new RefusedError("lock", 5))).toBe(1);
    expect(jobExitCode(new TypeError("fetch failed"))).toBe(1);
  });
});
