import { describe, expect, test } from "bun:test";
import { readSecretReference, type SecretSources } from "../../../src/config/secret-ref";

const PATH = "postgres.external.adminPassword";

function sources(env: Record<string, string | undefined>, files: Record<string, string> = {}): SecretSources {
  return { env, readFile: (path) => files[path] };
}

describe("readSecretReference", () => {
  test("reads the variable that the Env reference names", () => {
    expect(readSecretReference({ path: PATH, env: "PG_ADMIN" }, sources({ PG_ADMIN: "s3cret" }))).toEqual({ value: "s3cret" });
  });

  test("an unset or empty variable leaves the secret unsupplied, naming the variable and the reference", () => {
    const missing = { missing: "the environment variable PG_ADMIN that postgres.external.adminPasswordEnv names is not set" };
    expect(readSecretReference({ path: PATH, env: "PG_ADMIN" }, sources({}))).toEqual(missing);
    expect(readSecretReference({ path: PATH, env: "PG_ADMIN" }, sources({ PG_ADMIN: "" }))).toEqual(missing);
  });

  test("reads the file that the File reference names, without one trailing line break", () => {
    const files = { "/root/pg-admin": "s3cret\n", "/root/crlf": "s3cret\r\n", "/root/two": "s3cret\n\n" };
    expect(readSecretReference({ path: PATH, file: "/root/pg-admin" }, sources({}, files))).toEqual({ value: "s3cret" });
    expect(readSecretReference({ path: PATH, file: "/root/crlf" }, sources({}, files))).toEqual({ value: "s3cret" });
    expect(readSecretReference({ path: PATH, file: "/root/two" }, sources({}, files))).toEqual({ value: "s3cret\n" });
  });

  test("a missing or empty file leaves the secret unsupplied, naming the file", () => {
    expect(readSecretReference({ path: PATH, file: "/root/none" }, sources({}))).toEqual({
      missing: "the file /root/none that postgres.external.adminPasswordFile names does not exist",
    });
    expect(readSecretReference({ path: PATH, file: "/root/empty" }, sources({}, { "/root/empty": "\n" }))).toEqual({
      missing: "the file /root/empty that postgres.external.adminPasswordFile names is empty",
    });
  });

  test("without a reference the secret is unsupplied", () => {
    expect(readSecretReference({ path: PATH }, sources({ PG_ADMIN: "s3cret" }))).toEqual({
      missing: "neither postgres.external.adminPasswordEnv nor postgres.external.adminPasswordFile is set",
    });
  });
});
