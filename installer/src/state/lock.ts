// The run lock of Docker mode: /opt/libredb/state/lock, created with O_EXCL and holding the pid and host of the
// run, so a second run exits 5 while the first holds it. A lock left behind by a run whose pid no
// longer runs on this host is removed; a lock from another host is never removed, because its pid cannot be checked.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { ExitCode } from "../cli/exit-codes";
import { ensurePrivateDir } from "./file-store";

export const LOCK_FILE = "/opt/libredb/state/lock";

// Each attempt either creates the lock, finds a live holder, or removes a stale lock and tries again.
const MAX_ATTEMPTS = 3;

const lockOwner = z
  .object({
    pid: z.number().int().min(1),
    host: z.string().min(1),
    since: z.iso.datetime(),
  })
  .strict();

export type LockOwner = z.output<typeof lockOwner>;

/** A lock file as read: its exact text, and its holder when the text names one. */
export interface LockFile {
  readonly text: string;
  readonly owner: LockOwner | undefined;
}

/** Another run holds the lock, or a lock file does not name its holder. */
export class LockHeldError extends Error {
  readonly exitCode = ExitCode.LockHeld;
  readonly path: string;
  readonly owner: LockOwner | undefined;

  constructor(path: string, owner: LockOwner | undefined) {
    super(
      owner === undefined
        ? `${path} does not name the run that holds it; remove it once no installer runs on this host`
        : `another installer run holds ${path}: pid ${owner.pid} on ${owner.host} since ${owner.since}`,
    );
    this.name = "LockHeldError";
    this.path = path;
    this.owner = owner;
  }
}

export interface HeldLock {
  readonly path: string;
  readonly owner: LockOwner;
  /** Removes the lock, and refuses when the file no longer holds this run's lock. */
  release(): void;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Reads the lock file, or returns undefined when there is none. */
export function readLock(path: string = LOCK_FILE): LockFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { text, owner: undefined };
  }
  const parsed = lockOwner.safeParse(raw);
  return { text, owner: parsed.success ? parsed.data : undefined };
}

/** Whether a process with this pid runs on this host. A process of another user (EPERM) runs too. */
export function pidRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    return code === "EPERM";
  }
}

/** Creates the lock with O_CREAT | O_EXCL, or returns false when a lock file exists. */
function createExclusive(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    return false;
  }
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Removes a stale lock whose text was read as `staleText`. The file is moved aside first and compared, so a lock
 * that another run created after the read is put back instead of being removed.
 */
export function removeStaleLock(path: string, staleText: string): void {
  const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return;
  }
  if (readFileSync(aside, "utf8") !== staleText) linkSync(aside, path);
  unlinkSync(aside);
}

/** Takes the run lock, or throws LockHeldError (exit 5) while a live run holds it. */
export function acquireLock(path: string = LOCK_FILE): HeldLock {
  const owner: LockOwner = { pid: process.pid, host: hostname(), since: new Date().toISOString() };
  const text = `${JSON.stringify(owner)}\n`;
  ensurePrivateDir(dirname(path));
  for (let attempt = 1; ; attempt += 1) {
    if (createExclusive(path, text)) {
      return {
        path,
        owner,
        release() {
          if (readLock(path)?.text !== text) {
            throw new Error(`${path} no longer holds the lock of this run, so it is left in place`);
          }
          unlinkSync(path);
        },
      };
    }
    // A lock that vanished since the create attempt needs no removal: the next attempt creates the lock.
    const existing = readLock(path);
    const stale = existing?.owner !== undefined && existing.owner.host === owner.host && !pidRuns(existing.owner.pid);
    if (attempt === MAX_ATTEMPTS || (existing !== undefined && !stale)) throw new LockHeldError(path, existing?.owner);
    if (stale) removeStaleLock(path, existing.text);
  }
}
