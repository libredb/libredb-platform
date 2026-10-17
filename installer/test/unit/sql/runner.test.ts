import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  envFileText,
  parseResult,
  parseResults,
  pgEnvironment,
  PSQL_ARGS,
  resultQuery,
  runScript,
  SqlError,
} from "../../../src/sql/runner";
import { ADMIN_LOGIN, fakeRunner } from "./fixture";

describe("psql runner", () => {
  test("hands psql the login as PG* variables with verify-full against the mounted CA bundle", () => {
    expect(pgEnvironment(ADMIN_LOGIN)).toEqual({
      PGHOST: "postgres",
      PGPORT: "5432",
      PGDATABASE: "postgres",
      PGUSER: "postgres",
      PGPASSWORD: ADMIN_LOGIN.password,
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/etc/libredb/ca/ca.crt",
      PGAPPNAME: "libredb-installer",
      PGCONNECT_TIMEOUT: "10",
    });
    expect(PSQL_ARGS).toEqual(["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"]);
  });

  test("writes the variables as env file lines and refuses a value with a line break", () => {
    expect(envFileText({ PGUSER: "postgres", PGPASSWORD: "a=b c" })).toBe("PGUSER=postgres\nPGPASSWORD=a=b c\n");
    expect(() => envFileText({ PGPASSWORD: "one\ntwo" })).toThrow(
      "the value of PGPASSWORD contains a line break or a NUL character",
    );
  });

  test("runScript returns a successful run and rejects a failed one with SqlError naming the login", async () => {
    const ok = fakeRunner(() => ({ exitCode: 0, stdout: "1\n", stderr: "" }));
    expect(await runScript(ok, ADMIN_LOGIN, "SELECT 1;\n")).toEqual({ exitCode: 0, stdout: "1\n", stderr: "" });
    const failing = fakeRunner(() => ({ exitCode: 3, stdout: "", stderr: "" }));
    const error = await runScript(failing, ADMIN_LOGIN, "SELECT;\n").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SqlError);
    expect((error as SqlError).exitCode).toBe(1);
    expect((error as SqlError).message).toBe("psql as postgres on postgres:5432/postgres exited with code 3");
    expect((error as SqlError).result.exitCode).toBe(3);
  });

  test("result queries print one marked line that parseResults reads by name, ignoring every other line", () => {
    expect(resultQuery("facts", "jsonb_build_object('a', 1)")).toBe(
      "SELECT 'libredb-result facts ' || (jsonb_build_object('a', 1))::text;",
    );
    const results = parseResults(
      'Asynchronous notification "x" received\nlibredb-result facts {"a": 1}\nlibredb-result more [true]\n',
    );
    expect([...results]).toEqual([
      ["facts", { a: 1 }],
      ["more", [true]],
    ]);
  });

  test("parseResults refuses a result printed twice or as invalid JSON, without quoting it", () => {
    expect(() => parseResults("libredb-result a 1\nlibredb-result a 2\n")).toThrow("psql printed the result a twice");
    expect(() => parseResults("libredb-result a {secret\n")).toThrow("psql printed the result a as invalid JSON");
  });

  test("parseResult names every malformed path", () => {
    const schema = z.object({ a: z.number(), b: z.string() }).strict();
    expect(parseResult(schema, { a: 1, b: "x" }, "test facts")).toEqual({ a: 1, b: "x" });
    expect(() => parseResult(schema, { a: "1", b: 2 }, "test facts")).toThrow(
      /^the test facts are malformed: a: .+; b: .+$/,
    );
  });
});
