// Plans the files and directories a Docker step owns on the host: each is created when missing and rewritten when its
// content, mode or owner differs, so a step that finds them as rendered plans nothing. A summary never quotes content.
import type { Action } from "../engine/step";
import type { DirectorySpec } from "./layout";

/** What the host holds at a path, as the step observed it with lstat and, for a file, its content. */
export type ObservedPath =
  | { kind: "file"; mode: number; uid: number; gid: number; content: string }
  | { kind: "directory"; mode: number; uid: number; gid: number }
  | { kind: "other" };

/** A file as a step renders it. */
export interface FileSpec {
  path: string;
  content: string;
  mode: number;
  uid: number;
  gid: number;
}

export interface FileAction extends Action {
  kind: "file";
  file: FileSpec;
}

export interface DirectoryAction extends Action {
  kind: "directory";
  directory: DirectorySpec;
}

/** Four-digit octal, such as 0600. */
export function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function metadataChanges(
  desired: { mode: number; uid: number; gid: number },
  observed: { mode: number; uid: number; gid: number },
): string[] {
  const changes: string[] = [];
  if ((observed.mode & 0o777) !== desired.mode) changes.push(`mode ${octal(observed.mode)} to ${octal(desired.mode)}`);
  if (observed.uid !== desired.uid || observed.gid !== desired.gid) {
    changes.push(`owner ${observed.uid}:${observed.gid} to ${desired.uid}:${desired.gid}`);
  }
  return changes;
}

/** Refuses a path that holds something else than the step expects, which the installer never replaces. */
export class UnexpectedPathError extends Error {
  constructor(path: string, expected: "file" | "directory") {
    super(`${path} exists but is not a ${expected}; move it away, because the installer does not replace it`);
    this.name = "UnexpectedPathError";
  }
}

/** Plans one file: create it, rewrite it when its content differs, or fix its mode and owner. */
export function planFile(desired: FileSpec, observed: ObservedPath | undefined): FileAction[] {
  if (observed === undefined) return [{ kind: "file", file: desired, summary: `create ${desired.path}` }];
  if (observed.kind !== "file") throw new UnexpectedPathError(desired.path, "file");
  if (observed.content !== desired.content) {
    return [{ kind: "file", file: desired, summary: `update ${desired.path}` }];
  }
  const changes = metadataChanges(desired, observed);
  if (changes.length === 0) return [];
  return [{ kind: "file", file: desired, summary: `change ${changes.join(" and ")} of ${desired.path}` }];
}

/** Plans one directory: create it, or fix its mode and owner. */
export function planDirectory(desired: DirectorySpec, observed: ObservedPath | undefined): DirectoryAction[] {
  if (observed === undefined) {
    return [{ kind: "directory", directory: desired, summary: `create directory ${desired.path}` }];
  }
  if (observed.kind !== "directory") throw new UnexpectedPathError(desired.path, "directory");
  const changes = metadataChanges(desired, observed);
  if (changes.length === 0) return [];
  return [{ kind: "directory", directory: desired, summary: `change ${changes.join(" and ")} of ${desired.path}` }];
}
