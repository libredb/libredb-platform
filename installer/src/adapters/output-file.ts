// Writes the file that an operator names with -o, such as the export of `keycloak export`, the CA certificate of
// `tls export-ca` and the DBA script of `db-script`. These commands run as root, and the path may lie below a directory
// that another local user can write to, such as /tmp, where that user could plant a symbolic link or swap a directory
// so that root writes elsewhere, such as over /etc/shadow. So the path must not contain a symbolic link, and every
// directory from / down to the file must be owned by root, by the uid that runs the installer or, when root runs it
// under sudo, by the operator who ran sudo, and be writable by its owner only, unless it has the sticky bit as /tmp has.
// Then only root and the operator can change a directory of the path, so the check cannot be raced. The file is created
// by that resolved path where nothing exists yet, with O_EXCL and O_NOFOLLOW and its mode set through the descriptor,
// and --force writes a new file beside it and renames it over the path, which replaces a link instead of following it.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ExitCode } from "../cli/exit-codes";

const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const OPEN_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** S_IWGRP. */
const GROUP_WRITE = 0o020;
/** S_IWOTH. */
const OTHERS_WRITE = 0o002;
/** S_ISVTX: in a sticky directory only root and the owners of an entry or of the directory can rename the entry. */
const STICKY = 0o1000;

/** An output path the installer refuses to write, which the operator answers with another path or with --force. */
export class OutputPathError extends Error {
  readonly exitCode = ExitCode.InvalidUsage;

  constructor(message: string) {
    super(message);
    this.name = "OutputPathError";
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** The owners a directory of the path may have, and how a refusal names them. */
export interface TrustedOwners {
  uids: readonly number[];
  description: string;
}

/**
 * Who may own a directory of the path when `uid` runs the installer: root, `uid` itself, and when root runs it under
 * sudo, the operator who ran sudo, whose uid `sudoUid` (SUDO_UID) holds as a non-negative integer. The threat is other
 * local users, and the operator who ran sudo is not one of them. Any other SUDO_UID is ignored.
 */
export function trustedOwners(uid: number, sudoUid: string | undefined): TrustedOwners {
  if (uid !== 0) return { uids: [0, uid], description: `root or uid ${uid}, which runs the installer` };
  const operator = sudoUid !== undefined && /^[0-9]+$/.test(sudoUid) ? Number(sudoUid) : 0;
  if (operator === 0 || !Number.isSafeInteger(operator)) return { uids: [0], description: "root" };
  return { uids: [0, operator], description: `root or uid ${operator}, which ran sudo` };
}

/** Every directory from / down to the absolute `directory`, such as /, /var and /var/lib for /var/lib. */
function directoriesFromRoot(directory: string): string[] {
  const names = directory.split("/").filter((name) => name !== "");
  return ["/", ...names.map((_, index) => `/${names.slice(0, index + 1).join("/")}`)];
}

/**
 * Refuses the absolute `directory` unless nobody but `owners` can change it or a directory above it: from / down, each
 * must be a directory that one of `owners` owns, and one that group or others can write to must have the sticky bit.
 */
export function checkTrustedDirectory(directory: string, owners: TrustedOwners): void {
  for (const entry of directoriesFromRoot(directory)) {
    const stats = lstatSync(entry);
    if (!stats.isDirectory()) throw new OutputPathError(`${entry} exists but is not a directory`);
    if (!owners.uids.includes(stats.uid)) {
      throw new OutputPathError(
        `${entry} is owned by uid ${stats.uid}, and every directory of the path must be owned by ${owners.description}`,
      );
    }
    const group = (stats.mode & GROUP_WRITE) !== 0;
    const others = (stats.mode & OTHERS_WRITE) !== 0;
    if ((group || others) && (stats.mode & STICKY) === 0) {
      const writers = group && others ? "its group and others" : group ? "its group" : "others";
      throw new OutputPathError(
        `${entry} is writable by ${writers} without the sticky bit, so another user could redirect the path; run ` +
          `chmod ${group ? "g" : ""}${others ? "o" : ""}-w ${entry}, or name a path below a root-owned directory such as /root`,
      );
    }
  }
}

/**
 * Checks the existing absolute `directory`: it must hold no symbolic link, and nobody but the trusted owners of this
 * process may be able to change it. `shown` is the path the operator gave and `name` the entry below `directory` that
 * it names, so that a refusal names the path to pass instead.
 */
function trustedDirectory(directory: string, shown: string, name: string): string {
  let real: string;
  try {
    real = realpathSync(directory);
  } catch (error) {
    // A dangling link has no real path to name.
    if (errorCode(error) === "ENOENT" && lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      throw new OutputPathError(`${shown} must not contain a symbolic link`);
    }
    throw error;
  }
  if (real !== directory) {
    throw new OutputPathError(
      `${shown} must not contain a symbolic link; it resolves to ${join(real, name)}, so pass that instead`,
    );
  }
  checkTrustedDirectory(real, trustedOwners(process.getuid?.() ?? -1, process.env.SUDO_UID));
  return real;
}

/** Creates `path`, which must not exist yet, with `content` and exactly `mode`, and removes it again when writing fails. */
function createNew(path: string, content: string, mode: number): void {
  const fd = openSync(path, CREATE_NEW, mode);
  try {
    try {
      // The umask can only narrow the mode given to open, so set it exactly, through the descriptor and never by path.
      fchmodSync(fd, mode);
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

/** Why the entry that exists at `path` stays as it is, or undefined when --force replaces it. */
function keptBecause(path: string, entry: Stats, force: boolean): string | undefined {
  if (entry.isDirectory()) return `${path} is a directory, which the installer does not replace`;
  if (!entry.isFile() && !entry.isSymbolicLink()) return `${path} is not a regular file, which the installer does not replace`;
  if (force) return undefined;
  if (entry.isSymbolicLink()) {
    return `${path} is a symbolic link, which the installer never follows; pass --force to replace the link itself`;
  }
  return `${path} already exists; pass --force to replace it`;
}

/**
 * Writes `content` to `path` with exactly `mode`, by its resolved path below a trusted directory, never through a
 * symbolic link. A path that exists already is refused, unless `force` is set and it holds a regular file or a
 * symbolic link: then the content goes to a new file beside it, which is renamed over it, so a link or another hard
 * link to the old file is replaced and never written through.
 */
export function writeOutputFile(path: string, content: string, options: { mode: number; force: boolean }): void {
  if (path.endsWith("/")) throw new OutputPathError(`${path} ends with a slash, so it names a directory and not a file`);
  const absolute = resolve(path);
  const name = basename(absolute);
  const directory = trustedDirectory(dirname(absolute), path, name);
  const target = join(directory, name);
  try {
    createNew(target, content, options.mode);
    return;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const kept = keptBecause(path, lstatSync(target), options.force);
  if (kept !== undefined) throw new OutputPathError(kept);
  // A name that nobody can predict, created with O_EXCL as well, in the same checked directory.
  const temporary = join(directory, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  createNew(temporary, content, options.mode);
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Creates the directory `path` with exactly mode 0755, set through a descriptor of the new directory itself. */
function createDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o755 });
  } catch (error) {
    // Whatever appeared there since the caller looked is then checked like any existing directory.
    if (errorCode(error) === "EEXIST") return;
    throw error;
  }
  const fd = openSync(path, OPEN_DIRECTORY);
  try {
    // The umask can only narrow the mode given to mkdir.
    fchmodSync(fd, 0o755);
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes sure that the output directory `dir` exists, holds no symbolic link, and that nobody but the trusted owners of
 * this process can change it or a directory above it. A missing `dir` is created with mode 0755, only below an existing
 * parent that passes the same check; a missing parent is refused, naming it.
 */
export function ensureOutputDirectory(dir: string): void {
  // A trailing slash would make lstat follow a symbolic link, and resolve drops it.
  const absolute = resolve(dir);
  if (lstatSync(absolute, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(absolute);
    if (lstatSync(parent, { throwIfNoEntry: false }) === undefined) {
      throw new OutputPathError(`${dir} cannot be created, because its parent ${parent} does not exist; create the parent first`);
    }
    const name = basename(absolute);
    createDirectory(join(trustedDirectory(parent, dir, name), name));
  }
  trustedDirectory(absolute, dir, "");
}
