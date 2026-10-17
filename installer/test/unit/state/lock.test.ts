import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock, LOCK_FILE, LockHeldError, pidRuns, readLock, removeStaleLock } from "../../../src/state/lock";

const root = mkdtempSync(join(tmpdir(), "libredb-installer-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function freshPath(): string {
  counter += 1;
  return join(root, `case-${counter}`, "state", "lock");
}

const SECOND_RUN = join(import.meta.dir, "..", "..", "fixtures", "state", "second-run.ts");

function secondRun(path: string) {
  const result = Bun.spawnSync([process.execPath, SECOND_RUN, path], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

/** The pid of a process that has exited and been reaped, so no process runs with it. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "0"]);
  await child.exited;
  return child.pid;
}

function writeLock(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("acquireLock", () => {
  test("uses /opt/libredb/state/lock by default", () => {
    expect(LOCK_FILE).toBe("/opt/libredb/state/lock");
  });

  test("a second run exits 5 while the first holds the lock", () => {
    const path = freshPath();
    const lock = acquireLock(path);
    const held = readFileSync(path, "utf8");
    expect(JSON.parse(held)).toMatchObject({ pid: process.pid, host: hostname() });
    expect(lock.owner).toMatchObject({ pid: process.pid, host: hostname() });

    const second = secondRun(path);
    expect(second.exitCode).toBe(5);
    expect(second.stderr).toContain(`pid ${process.pid} on ${hostname()}`);
    expect(readFileSync(path, "utf8")).toBe(held);

    lock.release();
    expect(existsSync(path)).toBe(false);
    expect(secondRun(path).exitCode).toBe(0);
  });

  test("a lock whose pid no longer runs is removed", async () => {
    const path = freshPath();
    const pid = await deadPid();
    expect(pidRuns(pid)).toBe(false);
    writeLock(path, `${JSON.stringify({ pid, host: hostname(), since: "2026-10-14T22:00:00.000Z" })}\n`);

    const lock = acquireLock(path);
    expect(readLock(path)?.owner).toEqual(lock.owner);
    expect(lock.owner.pid).toBe(process.pid);
    expect(readdirSync(dirname(path))).toEqual(["lock"]);
    lock.release();
  });

  test("a lock of a run on another host is never removed, because its pid cannot be checked", async () => {
    const path = freshPath();
    const content = `${JSON.stringify({ pid: await deadPid(), host: "builder-7.corp", since: "2026-10-14T22:00:00.000Z" })}\n`;
    writeLock(path, content);

    const error = thrown(() => acquireLock(path));
    expect(error).toBeInstanceOf(LockHeldError);
    expect((error as LockHeldError).exitCode).toBe(5);
    expect((error as Error).message).toContain("on builder-7.corp since 2026-10-14T22:00:00.000Z");
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  test("a lock file that does not name its holder is reported and kept", () => {
    const path = freshPath();
    writeLock(path, "");

    const error = thrown(() => acquireLock(path));
    expect(error).toBeInstanceOf(LockHeldError);
    expect((error as LockHeldError).owner).toBeUndefined();
    expect((error as Error).message).toBe(
      `${path} does not name the run that holds it; remove it once no installer runs on this host`,
    );
    expect(readFileSync(path, "utf8")).toBe("");
  });

  test("release refuses to remove a lock that another run's lock replaced", () => {
    const path = freshPath();
    const lock = acquireLock(path);
    const other = `${JSON.stringify({ pid: 4242, host: "builder-7.corp", since: "2026-10-15T08:00:00.000Z" })}\n`;
    writeFileSync(path, other);

    const error = thrown(() => lock.release());
    expect((error as Error).message).toBe(`${path} no longer holds the lock of this run, so it is left in place`);
    expect(readFileSync(path, "utf8")).toBe(other);
  });
});

describe("removeStaleLock", () => {
  test("removes the stale lock it read, and puts back a lock that another run took after the read", () => {
    const path = freshPath();
    writeLock(path, "stale");
    removeStaleLock(path, "stale");
    expect(existsSync(path)).toBe(false);

    writeLock(path, "fresh");
    removeStaleLock(path, "stale");
    expect(readFileSync(path, "utf8")).toBe("fresh");
    expect(readdirSync(dirname(path))).toEqual(["lock"]);

    rmSync(path);
    removeStaleLock(path, "stale");
    expect(readdirSync(dirname(path))).toEqual([]);
  });
});

describe("pidRuns", () => {
  test("tells a running process from one that exited", async () => {
    expect(pidRuns(process.pid)).toBe(true);
    // pid 1 runs under another user unless the tests run as root, and counts as running either way.
    expect(pidRuns(1)).toBe(true);
    expect(pidRuns(await deadPid())).toBe(false);
  });
});

describe("readLock", () => {
  test("reads the holder, and nothing when there is no lock", () => {
    const path = freshPath();
    expect(readLock(path)).toBeUndefined();
    const content = `${JSON.stringify({ pid: 4242, host: "builder-7.corp", since: "2026-10-15T08:00:00.000Z" })}\n`;
    writeLock(path, content);
    expect(readLock(path)).toEqual({
      text: content,
      owner: { pid: 4242, host: "builder-7.corp", since: "2026-10-15T08:00:00.000Z" },
    });
    writeLock(path, '{"pid":0,"host":"x","since":"2026-10-15T08:00:00.000Z"}');
    expect(readLock(path)?.owner).toBeUndefined();
  });
});
