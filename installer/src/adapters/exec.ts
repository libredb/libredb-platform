// Runs a subprocess with a timeout. Every output line passes through the redactor before it reaches the log or
// the returned output, so a registered secret printed by a subprocess never leaves the process in clear.
import type { Redactor } from "../log/redact";

export type OutputStream = "stdout" | "stderr";

export interface OutputLine {
  stream: OutputStream;
  /** The redacted line, without its line break. */
  text: string;
}

export interface ExecOptions {
  redactor: Redactor;
  /** The subprocess is sent SIGTERM after this many milliseconds, and SIGKILL after the grace period. */
  timeoutMs: number;
  /** Receives every redacted output line as it arrives. */
  log: (line: OutputLine) => void;
  stdin?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Rejects with ExecError when the exit code is not 0. */
  check?: boolean;
}

export interface ExecResult {
  /** The redacted command line. */
  argv: readonly string[];
  exitCode: number;
  /** The redacted standard output. */
  stdout: string;
  /** The redacted standard error. */
  stderr: string;
}

// How long a subprocess has to exit after SIGTERM before it gets SIGKILL.
const KILL_GRACE_MS = 2_000;

/** A subprocess exited with a non-zero code while the caller required success. */
export class ExecError extends Error {
  readonly result: ExecResult;

  constructor(result: ExecResult) {
    const stderr = result.stderr.trim();
    super(`${result.argv.join(" ")} exited with code ${result.exitCode}${stderr === "" ? "" : `: ${stderr}`}`);
    this.name = "ExecError";
    this.result = result;
  }
}

/** A subprocess ran past its timeout and was killed. */
export class ExecTimeoutError extends Error {
  readonly argv: readonly string[];
  readonly pid: number;
  readonly timeoutMs: number;

  constructor(argv: readonly string[], pid: number, timeoutMs: number) {
    super(`${argv.join(" ")} did not finish within ${timeoutMs} ms and was killed`);
    this.name = "ExecTimeoutError";
    this.argv = argv;
    this.pid = pid;
    this.timeoutMs = timeoutMs;
  }
}

/** Reads a stream line by line, hands each redacted line to the log and returns the redacted text. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  name: OutputStream,
  options: ExecOptions,
): Promise<string> {
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  const emit = (line: string, newline: boolean) => {
    const redacted = options.redactor.redact(line);
    options.log({ stream: name, text: redacted });
    text += newline ? `${redacted}\n` : redacted;
  };
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let end = pending.indexOf("\n");
    while (end !== -1) {
      emit(pending.slice(0, end), true);
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending !== "") emit(pending, false);
  return text;
}

export async function exec(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
  if (argv.length === 0) throw new Error("exec needs a command");
  // An argument can carry a secret, and the command line appears in errors and results.
  const shown = argv.map((arg) => options.redactor.redact(arg));
  const child = Bun.spawn([...argv], {
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: options.env ?? process.env,
    cwd: options.cwd,
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  }, options.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      drain(child.stdout, "stdout", options),
      drain(child.stderr, "stderr", options),
      child.exited,
    ]);
    if (timedOut) throw new ExecTimeoutError(shown, child.pid, options.timeoutMs);
    const result: ExecResult = { argv: shown, exitCode, stdout, stderr };
    if (options.check === true && exitCode !== 0) throw new ExecError(result);
    return result;
  } finally {
    clearTimeout(timeoutTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }
}
