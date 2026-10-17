import { describe, expect, test } from "bun:test";
import { exec, ExecError, ExecTimeoutError, type OutputLine } from "../../../src/adapters/exec";
import { REDACTED, Redactor } from "../../../src/log/redact";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("exec", () => {
  test("a registered secret printed by a subprocess reaches the log redacted, and a subprocess that outlives its timeout is killed", async () => {
    const secret = "s3cr3t-Value_0123456789abcdefghijklmnopqrstuv";
    const redactor = new Redactor();
    redactor.register(secret);
    const log: OutputLine[] = [];

    const result = await exec(["sh", "-c", `echo "password=${secret}"; echo "warn ${secret}" >&2; echo done`], {
      redactor,
      timeoutMs: 10_000,
      log: (line) => log.push(line),
    });
    expect(result.exitCode).toBe(0);
    // The two streams are read concurrently, so only the order within each stream is fixed.
    expect(log.filter((line) => line.stream === "stdout").map((line) => line.text)).toEqual([
      `password=${REDACTED}`,
      "done",
    ]);
    expect(log.filter((line) => line.stream === "stderr").map((line) => line.text)).toEqual([`warn ${REDACTED}`]);
    expect(JSON.stringify(log)).not.toContain(secret);
    expect(result.stdout).toBe(`password=${REDACTED}\ndone\n`);
    expect(result.stderr).toBe(`warn ${REDACTED}\n`);

    const started = Date.now();
    const timedOut = exec(["sleep", "30"], { redactor, timeoutMs: 200, log: () => {} });
    const error = await timedOut.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ExecTimeoutError);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = (error as ExecTimeoutError).pid;
    expect(isRunning(pid)).toBe(false);
  });

  test("a line without a trailing newline is still logged, and a non-zero exit is returned", async () => {
    const log: OutputLine[] = [];
    const result = await exec(["sh", "-c", "printf 'partial'; exit 3"], {
      redactor: new Redactor(),
      timeoutMs: 10_000,
      log: (line) => log.push(line),
    });
    expect(result.exitCode).toBe(3);
    expect(log).toEqual([{ stream: "stdout", text: "partial" }]);
  });

  test("check rejects a non-zero exit with ExecError naming the command, the code and the redacted stderr", async () => {
    const redactor = new Redactor();
    redactor.register("hunter2-hunter2");
    const error = await exec(["sh", "-c", "echo 'bad hunter2-hunter2' >&2; exit 4"], {
      redactor,
      timeoutMs: 10_000,
      log: () => {},
      check: true,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ExecError);
    expect((error as ExecError).result.exitCode).toBe(4);
    expect((error as Error).message).toContain("exited with code 4");
    expect((error as Error).message).toContain(`bad ${REDACTED}`);
    expect((error as Error).message).not.toContain("hunter2-hunter2");
  });

  test("stdin is written to the subprocess", async () => {
    const result = await exec(["cat"], { redactor: new Redactor(), timeoutMs: 10_000, log: () => {}, stdin: "a\nb\n" });
    expect(result.stdout).toBe("a\nb\n");
  });
});
