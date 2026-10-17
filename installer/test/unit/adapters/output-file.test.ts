import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkTrustedDirectory,
  ensureOutputDirectory,
  OutputPathError,
  trustedOwners,
  writeOutputFile,
} from "../../../src/adapters/output-file";

// The real path of the temporary directory, because an output path must not contain a symbolic link.
const root = mkdtempSync(join(realpathSync(tmpdir()), "libredb-output-file-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const uid = process.getuid?.() ?? -1;
const isRoot = uid === 0;

let counter = 0;
/** A new empty directory for one case, writable by its owner only, as every directory of an output path must be. */
function scratch(): string {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  mkdirSync(dir, { mode: 0o755 });
  return dir;
}

/** A directory with exactly `mode`, which the umask cannot narrow. */
function directoryWithMode(path: string, mode: number): string {
  mkdirSync(path);
  chmodSync(path, mode);
  return path;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** A file with mode 0600 that stands in for a file such as /etc/shadow, which a planted link points at. */
function canary(dir: string): string {
  const path = join(dir, "canary");
  writeFileSync(path, "canary\n");
  chmodSync(path, 0o600);
  return path;
}

function refusal(write: () => void): string {
  try {
    write();
  } catch (error) {
    if (error instanceof OutputPathError) return error.message;
    throw error;
  }
  throw new Error("expected an OutputPathError");
}

/** Runs `body` with the umask set to `mask`, and restores the previous umask after it. */
function withUmask(mask: number, body: () => void): void {
  const previous = process.umask(mask);
  try {
    body();
  } finally {
    process.umask(previous);
  }
}

/** Runs `body` with SUDO_UID set to `value`, or unset for undefined, and restores the previous value after it. */
function withSudoUid(value: string | undefined, body: () => void): void {
  const previous = process.env.SUDO_UID;
  if (value === undefined) delete process.env.SUDO_UID;
  else process.env.SUDO_UID = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.SUDO_UID;
    else process.env.SUDO_UID = previous;
  }
}

// What a refusal of a directory that group or others can write to without the sticky bit says, by the writers.
function writableRefusal(dir: string, writers: string, chmod: string): string {
  return (
    `${dir} is writable by ${writers} without the sticky bit, so another user could redirect the path; run ` +
    `chmod ${chmod} ${dir}, or name a path below a root-owned directory such as /root`
  );
}

// The as-root cases need root twice: SUDO_UID counts only when root runs the installer, and only root can chown.
const ROOT_ONLY = "runs as root only, because SUDO_UID counts only for root and only root can chown";

describe("writeOutputFile", () => {
  test("creates a fresh file with exactly the given mode, even when the umask narrows it", () => {
    const path = join(scratch(), "ca.crt");
    withUmask(0o077, () => writeOutputFile(path, "certificate\n", { mode: 0o644, force: false }));
    expect(readFileSync(path, "utf8")).toBe("certificate\n");
    expect(mode(path)).toBe(0o644);
  });

  test("refuses a symbolic link at the path and leaves the file it points at unchanged", () => {
    const dir = scratch();
    const target = canary(dir);
    const path = join(dir, "ca.crt");
    symlinkSync(target, path);
    expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: false }))).toBe(
      `${path} is a symbolic link, which the installer never follows; pass --force to replace the link itself`,
    );
    expect(readlinkSync(path)).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("canary\n");
    expect(mode(target)).toBe(0o600);
  });

  test("refuses a dangling symbolic link at the path instead of creating the file it names", () => {
    const dir = scratch();
    const path = join(dir, "ca.crt");
    const named = join(dir, "created-through-the-link");
    symlinkSync(named, path);
    expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: false }))).toBe(
      `${path} is a symbolic link, which the installer never follows; pass --force to replace the link itself`,
    );
    expect(existsSync(named)).toBe(false);
  });

  test("with force replaces a symbolic link at the path by the file, and leaves the file it pointed at unchanged", () => {
    const dir = scratch();
    const target = canary(dir);
    const path = join(dir, "ca.crt");
    symlinkSync(target, path);
    writeOutputFile(path, "certificate\n", { mode: 0o644, force: true });
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("certificate\n");
    expect(mode(path)).toBe(0o644);
    expect(readFileSync(target, "utf8")).toBe("canary\n");
    expect(mode(target)).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(["ca.crt", "canary"]);
  });

  test("refuses an existing file without force, and with force replaces it with exactly the given mode", () => {
    const dir = scratch();
    const path = join(dir, "ca.crt");
    writeFileSync(path, "old\n");
    chmodSync(path, 0o600);
    expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: false }))).toBe(
      `${path} already exists; pass --force to replace it`,
    );
    expect(readFileSync(path, "utf8")).toBe("old\n");
    expect(mode(path)).toBe(0o600);

    withUmask(0o077, () => writeOutputFile(path, "certificate\n", { mode: 0o644, force: true }));
    expect(readFileSync(path, "utf8")).toBe("certificate\n");
    expect(mode(path)).toBe(0o644);
    expect(readdirSync(dir)).toEqual(["ca.crt"]);
  });

  test("with force replaces the path's own entry, so another hard link to the old file keeps its content", () => {
    const dir = scratch();
    const target = canary(dir);
    const path = join(dir, "ca.crt");
    linkSync(target, path);
    writeOutputFile(path, "certificate\n", { mode: 0o644, force: true });
    expect(readFileSync(path, "utf8")).toBe("certificate\n");
    expect(readFileSync(target, "utf8")).toBe("canary\n");
    expect(mode(target)).toBe(0o600);
  });

  test("refuses a directory at the path, with or without force, and leaves it in place", () => {
    const dir = scratch();
    const path = join(dir, "ca.crt");
    mkdirSync(path);
    for (const force of [false, true]) {
      expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force }))).toBe(
        `${path} is a directory, which the installer does not replace`,
      );
    }
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual(["ca.crt"]);
  });

  test("refuses a FIFO at the path, as it would a device such as /dev/null, with or without force", () => {
    const dir = scratch();
    const path = join(dir, "ca.crt");
    const made = Bun.spawnSync(["mkfifo", path]);
    if (made.exitCode !== 0) throw new Error(`mkfifo exited with ${made.exitCode}: ${made.stderr.toString()}`);
    for (const force of [false, true]) {
      expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force }))).toBe(
        `${path} is not a regular file, which the installer does not replace`,
      );
    }
    expect(lstatSync(path).isFIFO()).toBe(true);
    expect(readdirSync(dir)).toEqual(["ca.crt"]);
  });

  test("fails with the system error when the parent directory is missing", () => {
    const path = join(scratch(), "missing", "ca.crt");
    expect(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: false })).toThrow(/^ENOENT/);
  });

  test("refuses a path that ends with a slash, which names a directory and not a file", () => {
    const path = `${join(scratch(), "ca.crt")}/`;
    expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: true }))).toBe(
      `${path} ends with a slash, so it names a directory and not a file`,
    );
    expect(existsSync(path.slice(0, -1))).toBe(false);
  });

  test("refuses a symbolic link among the directories of the path, naming the path it resolves to", () => {
    const dir = scratch();
    const real = join(dir, "real");
    mkdirSync(join(real, "sub"), { recursive: true, mode: 0o755 });
    const link = join(dir, "link");
    symlinkSync(real, link);
    for (const [path, resolved] of [
      [join(link, "ca.crt"), join(real, "ca.crt")],
      [join(link, "sub", "ca.crt"), join(real, "sub", "ca.crt")],
    ] as const) {
      expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: true }))).toBe(
        `${path} must not contain a symbolic link; it resolves to ${resolved}, so pass that instead`,
      );
    }
    expect(readdirSync(real)).toEqual(["sub"]);
    expect(readdirSync(join(real, "sub"))).toEqual([]);
  });

  test("refuses a dangling symbolic link as the directory of the path", () => {
    const dir = scratch();
    const link = join(dir, "link");
    symlinkSync(join(dir, "missing"), link);
    const path = join(link, "ca.crt");
    expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: true }))).toBe(
      `${path} must not contain a symbolic link`,
    );
    expect(readdirSync(dir)).toEqual(["link"]);
  });

  test("refuses a directory of the path that group or others can write to without the sticky bit, naming the chmod that fixes it", () => {
    for (const [writable, writers, chmod] of [
      [0o775, "its group", "g-w"],
      [0o757, "others", "o-w"],
      [0o777, "its group and others", "go-w"],
    ] as const) {
      const dir = directoryWithMode(join(scratch(), "shared"), writable);
      const path = join(dir, "ca.crt");
      expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: true }))).toBe(
        writableRefusal(dir, writers, chmod),
      );
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test("refuses a path below such a directory as well, because the walk checks every directory from / down", () => {
    const shared = directoryWithMode(join(scratch(), "shared"), 0o777);
    const own = join(shared, "own");
    mkdirSync(own, { mode: 0o755 });
    expect(refusal(() => writeOutputFile(join(own, "ca.crt"), "certificate\n", { mode: 0o644, force: false }))).toBe(
      writableRefusal(shared, "its group and others", "go-w"),
    );
    expect(readdirSync(own)).toEqual([]);
  });

  test("accepts a directory that everyone can write to when it has the sticky bit, as /tmp has", () => {
    const sticky = directoryWithMode(join(scratch(), "sticky"), 0o1777);
    const path = join(sticky, "ca.crt");
    writeOutputFile(path, "certificate\n", { mode: 0o644, force: false });
    expect(readFileSync(path, "utf8")).toBe("certificate\n");
    expect(mode(path)).toBe(0o644);
  });

  test.skipIf(!isRoot)(
    `as root, refuses a directory that another uid owns and others can write to without the sticky bit (${ROOT_ONLY})`,
    () => {
      const foreign = directoryWithMode(join(scratch(), "foreign"), 0o777);
      chownSync(foreign, 4242, 4242);
      const path = join(foreign, "ca.crt");
      withSudoUid(undefined, () => {
        expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: true }))).toBe(
          `${foreign} is owned by uid 4242, and every directory of the path must be owned by root`,
        );
      });
      expect(readdirSync(foreign)).toEqual([]);
    },
  );

  test.skipIf(!isRoot)(`as root under sudo, accepts a directory that the uid in SUDO_UID owns (${ROOT_ONLY})`, () => {
    const operator = directoryWithMode(join(scratch(), "operator"), 0o755);
    chownSync(operator, 4242, 4242);
    const path = join(operator, "ca.crt");
    withSudoUid("4242", () => writeOutputFile(path, "certificate\n", { mode: 0o644, force: false }));
    expect(readFileSync(path, "utf8")).toBe("certificate\n");
  });

  test.skipIf(!isRoot)(`as root under sudo, still refuses a directory that another uid owns (${ROOT_ONLY})`, () => {
    const other = directoryWithMode(join(scratch(), "other"), 0o755);
    chownSync(other, 4242, 4242);
    const path = join(other, "ca.crt");
    withSudoUid("4243", () => {
      expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: false }))).toBe(
        `${other} is owned by uid 4242, and every directory of the path must be owned by root or uid 4243, which ran sudo`,
      );
    });
    expect(readdirSync(other)).toEqual([]);
  });

  test.skipIf(!isRoot)(`as root, ignores a SUDO_UID that is not a number (${ROOT_ONLY})`, () => {
    const operator = directoryWithMode(join(scratch(), "operator"), 0o755);
    chownSync(operator, 4242, 4242);
    const path = join(operator, "ca.crt");
    withSudoUid("4242abc", () => {
      expect(refusal(() => writeOutputFile(path, "certificate\n", { mode: 0o644, force: false }))).toBe(
        `${operator} is owned by uid 4242, and every directory of the path must be owned by root`,
      );
    });
    expect(readdirSync(operator)).toEqual([]);
  });
});

describe("trustedOwners", () => {
  test("as root without sudo trusts root alone", () => {
    expect(trustedOwners(0, undefined)).toEqual({ uids: [0], description: "root" });
  });

  test("as root under sudo also trusts the uid in SUDO_UID, the operator who ran sudo", () => {
    expect(trustedOwners(0, "1000")).toEqual({ uids: [0, 1000], description: "root or uid 1000, which ran sudo" });
  });

  test("as root ignores a SUDO_UID that is not a non-negative integer, and SUDO_UID 0, which is root", () => {
    for (const value of ["", "abc", "4242abc", "-1", "1e3", " 1000", "1000 ", "10.5", "0x3e8", "99999999999999999999", "0"]) {
      expect({ value, owners: trustedOwners(0, value) }).toEqual({ value, owners: { uids: [0], description: "root" } });
    }
  });

  test("as another uid trusts root and that uid, and ignores SUDO_UID", () => {
    expect(trustedOwners(1000, "4242")).toEqual({
      uids: [0, 1000],
      description: "root or uid 1000, which runs the installer",
    });
  });
});

describe("checkTrustedDirectory", () => {
  test("accepts a directory when root and the owners trusted for this process own every directory from / down", () => {
    expect(() => checkTrustedDirectory(scratch(), trustedOwners(uid, undefined))).not.toThrow();
  });

  // As root every temporary directory belongs to root, which is always trusted, so these run as another uid, standing
  // in for the operator who ran sudo; the as-root cases above chown instead.
  const NOT_ROOT = "runs as another uid only, because as root every temporary directory belongs to root";

  test.skipIf(isRoot)(`accepts the directories of the operator who ran sudo, as root would (${NOT_ROOT})`, () => {
    expect(() => checkTrustedDirectory(scratch(), trustedOwners(0, String(uid)))).not.toThrow();
  });

  test.skipIf(isRoot)(`refuses the first directory from / down that neither root nor SUDO_UID owns (${NOT_ROOT})`, () => {
    const dir = scratch();
    expect(refusal(() => checkTrustedDirectory(dir, trustedOwners(0, "4242")))).toBe(
      `${root} is owned by uid ${uid}, and every directory of the path must be owned by root or uid 4242, which ran sudo`,
    );
  });

  test.skipIf(isRoot)(`ignores a SUDO_UID that is not a number, as root would (${NOT_ROOT})`, () => {
    const dir = scratch();
    expect(refusal(() => checkTrustedDirectory(dir, trustedOwners(0, "abc")))).toBe(
      `${root} is owned by uid ${uid}, and every directory of the path must be owned by root`,
    );
  });
});

describe("ensureOutputDirectory", () => {
  test("creates a missing directory with exactly mode 0755 below a trusted parent, even when the umask narrows it", () => {
    const dir = join(scratch(), "export");
    withUmask(0o077, () => ensureOutputDirectory(dir));
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(mode(dir)).toBe(0o755);
  });

  test("refuses a missing directory whose parent is missing as well, naming the parent, and creates nothing", () => {
    const base = scratch();
    const dir = join(base, "parent", "export");
    expect(refusal(() => ensureOutputDirectory(dir))).toBe(
      `${dir} cannot be created, because its parent ${join(base, "parent")} does not exist; create the parent first`,
    );
    expect(readdirSync(base)).toEqual([]);
  });

  test("accepts an existing directory and keeps its mode", () => {
    const dir = scratch();
    chmodSync(dir, 0o700);
    ensureOutputDirectory(dir);
    expect(mode(dir)).toBe(0o700);
  });

  test("refuses a symbolic link to a directory, also when the path ends with a slash, naming the path it resolves to", () => {
    const base = scratch();
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o755 });
    const link = join(base, "export");
    symlinkSync(real, link);
    expect(refusal(() => ensureOutputDirectory(link))).toBe(
      `${link} must not contain a symbolic link; it resolves to ${real}, so pass that instead`,
    );
    expect(refusal(() => ensureOutputDirectory(`${link}/`))).toBe(
      `${link}/ must not contain a symbolic link; it resolves to ${real}, so pass that instead`,
    );
    expect(readlinkSync(link)).toBe(real);
  });

  test("refuses a dangling symbolic link instead of creating the directory it names", () => {
    const base = scratch();
    const named = join(base, "created-through-the-link");
    const link = join(base, "export");
    symlinkSync(named, link);
    expect(refusal(() => ensureOutputDirectory(link))).toBe(`${link} must not contain a symbolic link`);
    expect(existsSync(named)).toBe(false);
  });

  test("refuses a path that exists but is not a directory", () => {
    const file = join(scratch(), "export");
    writeFileSync(file, "not a directory\n");
    expect(refusal(() => ensureOutputDirectory(file))).toBe(`${file} exists but is not a directory`);
    expect(readFileSync(file, "utf8")).toBe("not a directory\n");
  });

  test("refuses to create a missing directory below a symbolic link, and creates nothing through it", () => {
    const base = scratch();
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o755 });
    const link = join(base, "link");
    symlinkSync(real, link);
    const dir = join(link, "export");
    expect(refusal(() => ensureOutputDirectory(dir))).toBe(
      `${dir} must not contain a symbolic link; it resolves to ${join(real, "export")}, so pass that instead`,
    );
    expect(readdirSync(real)).toEqual([]);
  });

  test("refuses an existing directory below a symbolic link", () => {
    const base = scratch();
    const real = join(base, "real");
    mkdirSync(join(real, "export"), { recursive: true, mode: 0o755 });
    const link = join(base, "link");
    symlinkSync(real, link);
    const dir = join(link, "export");
    expect(refusal(() => ensureOutputDirectory(dir))).toBe(
      `${dir} must not contain a symbolic link; it resolves to ${join(real, "export")}, so pass that instead`,
    );
  });

  test("refuses to create a missing directory below one that others can write to without the sticky bit", () => {
    const shared = directoryWithMode(join(scratch(), "shared"), 0o777);
    expect(refusal(() => ensureOutputDirectory(join(shared, "export")))).toBe(
      writableRefusal(shared, "its group and others", "go-w"),
    );
    expect(readdirSync(shared)).toEqual([]);
  });

  test("creates a missing directory below a sticky directory that everyone can write to, as /tmp is", () => {
    const sticky = directoryWithMode(join(scratch(), "sticky"), 0o1777);
    const dir = join(sticky, "export");
    ensureOutputDirectory(dir);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(mode(dir)).toBe(0o755);
  });
});
