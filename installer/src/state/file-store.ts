// Keeps the installer state of Docker mode in /opt/libredb/state/state.json with mode 0600. Every save writes a
// new file and renames it over the old one, so a reader or a crash sees the old state or the new one, never a mix.
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { emptyState, parseState, serializeState, type InstallerState, type StateStore } from "./store";

export const STATE_FILE = "/opt/libredb/state/state.json";

/** Creates the directory with mode 0700 when it is missing, and its missing parents with the default mode. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Writes `text` to a new 0600 file beside `path`, flushes it to disk and renames it over `path`. */
function writeFileAtomic(path: string, text: string): void {
  const dir = dirname(path);
  ensurePrivateDir(dir);
  const temporary = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      // The umask can narrow the mode given to open, so set it explicitly.
      fchmodSync(fd, 0o600);
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  // Flush the directory entry, so the rename itself survives a power loss.
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export class FileStateStore implements StateStore {
  readonly path: string;

  constructor(path: string = STATE_FILE) {
    this.path = path;
  }

  async load(): Promise<InstallerState> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyState();
    }
    return parseState(text, this.path);
  }

  async save(state: InstallerState): Promise<void> {
    writeFileAtomic(this.path, serializeState(state, this.path));
  }
}
