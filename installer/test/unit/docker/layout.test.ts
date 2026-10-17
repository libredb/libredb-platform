import { describe, expect, test } from "bun:test";
import { BASE_DIRECTORIES, POSTGRES_UID, TLS_DIRECTORIES, leafFiles, runLogFile } from "../../../src/docker/layout";

describe("Docker layout", () => {
  test("the base directories are /opt/libredb and its env, secrets, tls, ca, state, backups, logs and bin, private except the CA bundle and the installer binary", () => {
    expect(BASE_DIRECTORIES.map((directory) => [directory.path, directory.mode.toString(8)])).toEqual([
      ["/opt/libredb", "755"],
      ["/opt/libredb/env", "700"],
      ["/opt/libredb/secrets", "700"],
      ["/opt/libredb/tls", "700"],
      ["/opt/libredb/ca", "755"],
      ["/opt/libredb/state", "700"],
      ["/opt/libredb/backups", "700"],
      ["/opt/libredb/logs", "700"],
      ["/opt/libredb/bin", "755"],
    ]);
  });

  test("the PostgreSQL TLS directory belongs to the postgres user of the image", () => {
    expect(TLS_DIRECTORIES.at(-1)).toEqual({ path: "/opt/libredb/tls/postgres", mode: 0o700, uid: POSTGRES_UID, gid: POSTGRES_UID });
  });

  test("an endpoint leaf goes to the edge directory by hostname and the PostgreSQL leaf to the postgres directory", () => {
    expect(leafFiles({ name: "studio", hosts: ["studio.example.com"] })).toEqual({
      certificate: "/opt/libredb/tls/edge/studio.example.com.crt",
      key: "/opt/libredb/tls/edge/studio.example.com.key",
      uid: 0,
      gid: 0,
    });
    expect(leafFiles({ name: "postgres", hosts: ["postgres"] })).toEqual({
      certificate: "/opt/libredb/tls/postgres/server.crt",
      key: "/opt/libredb/tls/postgres/server.key",
      uid: 999,
      gid: 999,
    });
  });

  test("an endpoint leaf with other than one hostname is refused", () => {
    expect(() => leafFiles({ name: "studio", hosts: [] })).toThrow("covers 0");
    expect(() => leafFiles({ name: "studio", hosts: ["a.example.com", "b.example.com"] })).toThrow("covers 2");
  });

  test("the run log is named by its start time in UTC with milliseconds", () => {
    expect(runLogFile(new Date("2026-10-15T09:30:00.123Z"))).toBe("/opt/libredb/logs/installer-20261015T093000123Z.log");
  });
});
