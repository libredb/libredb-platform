// Observes and writes the files and directories the Docker steps own on the host. A file is replaced through a
// temporary sibling with its final mode and owner, then renamed, so a reader never sees it half written or exposed.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { UnexpectedPathError, type FileSpec, type ObservedPath } from "../docker/converge";
import type { DirectorySpec } from "../docker/layout";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** What the host holds at `path`, without following a symbolic link, or undefined when nothing is there. */
export function observePath(path: string): ObservedPath | undefined {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
    throw error;
  }
  const metadata = { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
  if (stats.isDirectory()) return { kind: "directory", ...metadata };
  if (stats.isFile()) return { kind: "file", ...metadata, content: readFileSync(path, "utf8") };
  return { kind: "other" };
}

/** The content of a regular file, or undefined when it does not exist. */
export function readOptionalFile(path: string): string | undefined {
  const observed = observePath(path);
  if (observed === undefined) return undefined;
  if (observed.kind !== "file") throw new Error(`${path} exists but is not a regular file`);
  return observed.content;
}

/** Creates the directory when missing and sets its mode and owner. Its parent must exist. */
export function applyDirectory(directory: DirectorySpec): void {
  try {
    mkdirSync(directory.path, { mode: directory.mode });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  chownSync(directory.path, directory.uid, directory.gid);
  chmodSync(directory.path, directory.mode);
}

/** Writes the file atomically with its mode and owner, creating missing parent directories with mode 0755. */
export function applyFile(file: FileSpec): void {
  const dir = dirname(file.path);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temporary = join(dir, `.${basename(file.path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      fchownSync(fd, file.uid, file.gid);
      fchmodSync(fd, file.mode);
      writeFileSync(fd, file.content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file.path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** A binary file as lstat and its bytes describe it, which observePath would read as text. */
export interface ObservedBinary {
  sha256: string;
  mode: number;
  uid: number;
  gid: number;
}

/** The binary at `path`, or undefined when nothing is there; anything but a regular file is refused. */
export function observeBinary(path: string): ObservedBinary | undefined {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
    throw error;
  }
  if (!stats.isFile()) throw new UnexpectedPathError(path, "file");
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { sha256, mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
}

/**
 * Copies a file byte for byte through a temporary sibling, then renames it into place, so a copy of a binary that is
 * running, such as the installer itself, replaces it without touching the running one.
 */
export function applyCopy(source: string, target: { path: string; mode: number; uid: number; gid: number }): void {
  const dir = dirname(target.path);
  const temporary = join(dir, `.${basename(target.path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chownSync(temporary, target.uid, target.gid);
    chmodSync(temporary, target.mode);
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target.path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
