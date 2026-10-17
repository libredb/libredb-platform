import { describe, expect, test } from "bun:test";
import { octal, planDirectory, planFile, UnexpectedPathError, type FileSpec } from "../../../src/docker/converge";

const file: FileSpec = { path: "/opt/libredb/env/postgres.env", content: "A=1\n", mode: 0o600, uid: 0, gid: 0 };
const directory = { path: "/opt/libredb/env", mode: 0o700, uid: 0, gid: 0 };

describe("planFile", () => {
  test("creates a missing file and rewrites one whose content differs, without quoting the content", () => {
    expect(planFile(file, undefined)).toEqual([{ kind: "file", file, summary: "create /opt/libredb/env/postgres.env" }]);
    const changed = planFile(file, { kind: "file", mode: 0o600, uid: 0, gid: 0, content: "A=2\n" });
    expect(changed).toEqual([{ kind: "file", file, summary: "update /opt/libredb/env/postgres.env" }]);
    expect(JSON.stringify(changed.map((action) => action.summary))).not.toContain("A=");
  });

  test("plans nothing for a file as rendered, and fixes a mode or an owner that drifted", () => {
    expect(planFile(file, { kind: "file", mode: 0o100600, uid: 0, gid: 0, content: "A=1\n" })).toEqual([]);
    expect(planFile(file, { kind: "file", mode: 0o644, uid: 1000, gid: 1000, content: "A=1\n" })).toEqual([
      {
        kind: "file",
        file,
        summary: "change mode 0644 to 0600 and owner 1000:1000 to 0:0 of /opt/libredb/env/postgres.env",
      },
    ]);
  });

  test("refuses a path that holds a directory or something else", () => {
    expect(() => planFile(file, { kind: "directory", mode: 0o700, uid: 0, gid: 0 })).toThrow(UnexpectedPathError);
    expect(() => planFile(file, { kind: "other" })).toThrow("is not a file");
  });
});

describe("planDirectory", () => {
  test("creates a missing directory, fixes its mode and plans nothing once it matches", () => {
    expect(planDirectory(directory, undefined)).toEqual([
      { kind: "directory", directory, summary: "create directory /opt/libredb/env" },
    ]);
    expect(planDirectory(directory, { kind: "directory", mode: 0o755, uid: 0, gid: 0 })).toEqual([
      { kind: "directory", directory, summary: "change mode 0755 to 0700 of /opt/libredb/env" },
    ]);
    expect(planDirectory(directory, { kind: "directory", mode: 0o700, uid: 0, gid: 0 })).toEqual([]);
  });

  test("refuses a file where a directory belongs", () => {
    expect(() => planDirectory(directory, { kind: "file", mode: 0o600, uid: 0, gid: 0, content: "" })).toThrow(
      "/opt/libredb/env exists but is not a directory",
    );
  });

  test("octal prints four digits", () => {
    expect(octal(0o40755)).toBe("0755");
    expect(octal(0o7)).toBe("0007");
  });
});
