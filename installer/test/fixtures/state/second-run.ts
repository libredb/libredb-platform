// A second installer run in its own process: takes the lock at argv[2] and exits with the lock's exit code.
import { acquireLock, LockHeldError } from "../../../src/state/lock";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: bun second-run.ts <lock path>");
try {
  acquireLock(path).release();
} catch (error) {
  if (!(error instanceof LockHeldError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(error.exitCode);
}
