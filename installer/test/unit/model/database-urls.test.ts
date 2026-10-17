import { describe, expect, test } from "bun:test";
import { migrateDatabaseUrl, platformDatabaseUrl, studioDatabaseUrl } from "../../../src/model/database-urls";

const server = { host: "postgres", port: 5432 };

describe("database URLs", () => {
  test("renders verify-full pg URLs and a Prisma-syntax MIGRATE_DATABASE_URL with schema=platform", () => {
    expect(platformDatabaseUrl(server, "pw-platform")).toBe(
      "postgresql://libredb_platform:pw-platform@postgres:5432/libredb?schema=platform&sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt",
    );
    expect(studioDatabaseUrl(server, "pw-studio")).toBe(
      "postgresql://libredb_studio:pw-studio@postgres:5432/libredb?sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt",
    );
    expect(migrateDatabaseUrl(server, "pw-owner")).toBe(
      "postgresql://libredb_owner:pw-owner@postgres:5432/libredb?schema=platform&sslmode=require&sslcert=/etc/libredb/ca/ca.crt&sslaccept=strict",
    );
  });

  test("percent-encodes the password and brackets an IPv6 host", () => {
    const url = studioDatabaseUrl({ host: "fd00::5", port: 6432 }, "p@ss/w:rd%");
    expect(url).toStartWith("postgresql://libredb_studio:p%40ss%2Fw%3Ard%25@[fd00::5]:6432/libredb?");
    expect(decodeURIComponent(new URL(url).password)).toBe("p@ss/w:rd%");
  });

  test("refuses an empty password and a port outside 1 to 65535", () => {
    expect(() => platformDatabaseUrl(server, "")).toThrow("no password for libredb_platform");
    expect(() => studioDatabaseUrl({ host: "postgres", port: 0 }, "pw")).toThrow("invalid PostgreSQL port 0");
  });
});
