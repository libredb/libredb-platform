import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "../../../src/log/redact";
import { FileSecretStore, SECRET_STORE_FILE, writeFileAtomic } from "../../../src/secrets/file-store";
import { SecretStoreError } from "../../../src/secrets/store";

const root = mkdtempSync(join(tmpdir(), "libredb-installer-secrets-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** A store directory that does not exist yet. */
function freshDir(): string {
  counter += 1;
  return join(root, `store-${counter}`);
}

function open(dir: string, redactor = new Redactor()): FileSecretStore {
  return new FileSecretStore({ dir, redactor });
}

/** Writes a store file by hand, as an operator or a restore might. */
function writeStore(dir: string, content: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, SECRET_STORE_FILE);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });
  return file;
}

async function storeError(run: () => Promise<unknown>): Promise<SecretStoreError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SecretStoreError) return error;
    throw error;
  }
  throw new Error("expected a SecretStoreError");
}

const GENERATED = /^[A-Za-z0-9_-]{43}$/;
const NAMES = [
  "platform.auth-secret",
  "studio.jwt-secret",
  "studio.storage-encryption-key",
  "postgres.libredb_owner",
  "postgres.libredb_platform",
  "postgres.libredb_studio",
] as const;

// RFC 7748 section 6.1 keys as base64url, with their public keys and kids.
const ALICE = {
  kid: "300c9c9603b92a4b",
  publicKey: "hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo",
  privateKey: "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo",
};
const BOB = {
  kid: "f35e5616160a30bf",
  publicKey: "3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hbeGdNrfx-FG-IK08",
  privateKey: "XasIfmJKikt54X-Lg4AO5m87sSkmGLb9HC-LJ_-I4Os",
};

describe("FileSecretStore values", () => {
  test("a second ensure returns identical values and the store file mode is 0600", async () => {
    const dir = freshDir();

    const first = await open(dir).ensure(NAMES);
    const [sealKey] = await open(dir).ensureSealKey();
    const second = await open(dir).ensure(NAMES);

    expect(second).toEqual(first);
    expect(statSync(join(dir, SECRET_STORE_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Every generated value is an independent draw of 32 random bytes, so no secret derives from another.
    const generated = [...Object.values(first), sealKey?.privateKey];
    for (const value of generated) expect(value).toMatch(GENERATED);
    expect(new Set(generated).size).toBe(NAMES.length + 1);
  });

  test("ensure generates only the absent names and leaves the file untouched when none is absent", async () => {
    const dir = freshDir();
    const { alpha } = await open(dir).ensure(["alpha"]);

    const both = await open(dir).ensure(["alpha", "beta"]);
    expect(both).toEqual({ alpha, beta: expect.stringMatching(GENERATED) });

    const file = join(dir, SECRET_STORE_FILE);
    const before = statSync(file);
    expect(await open(dir).ensure(["beta", "alpha", "beta"])).toEqual(both);
    // An atomic write replaces the file with a new inode, so an unchanged inode means nothing was written.
    expect(statSync(file).ino).toBe(before.ino);
  });

  test("get returns stored values and refuses a name the store does not hold, without creating the store", async () => {
    const empty = freshDir();
    expect((await storeError(() => open(empty).get(["alpha"]))).message).toContain("holds no value for alpha");
    expect(existsSync(empty)).toBe(false);

    const dir = freshDir();
    const { alpha } = await open(dir).ensure(["alpha"]);
    expect(await open(dir).get(["alpha"])).toEqual({ alpha });
    expect((await storeError(() => open(dir).get(["alpha", "gamma", "delta"]))).message).toContain(
      "holds no value for gamma, delta",
    );
  });

  test("an invalid secret name is refused before the store is touched", async () => {
    const dir = freshDir();
    for (const name of ["", "Alpha", "1alpha", "_alpha", "__proto__", "alpha/beta", `a${"b".repeat(128)}`]) {
      const error = await storeError(() => open(dir).ensure([name]));
      expect(error.message).toContain(`invalid secret name ${JSON.stringify(name)}`);
    }
    expect(existsSync(dir)).toBe(false);
  });

  test("every value read or generated is registered with the redactor", async () => {
    const dir = freshDir();
    // Each redactor is checked right after the call that generated the value, before any read could register it.
    const valueWriter = new Redactor();
    const { alpha } = await open(dir, valueWriter).ensure(["alpha"]);
    expect(valueWriter.redact(`alpha=${alpha}`)).toBe("alpha=[REDACTED]");
    const keyWriter = new Redactor();
    const [sealKey] = await open(dir, keyWriter).ensureSealKey();
    expect(keyWriter.redact(`key=${sealKey?.privateKey}`)).toBe("key=[REDACTED]");
    const issueWriter = new Redactor();
    const issued = await open(dir, issueWriter).issueSealKey();
    expect(issueWriter.redact(`key=${issued.privateKey}`)).toBe("key=[REDACTED]");

    const reader = new Redactor();
    await open(dir, reader).fingerprints();
    expect(reader.redact(`alpha=${alpha} key=${sealKey?.privateKey}`)).toBe("alpha=[REDACTED] key=[REDACTED]");
  });
});

describe("FileSecretStore supplied values", () => {
  test("put stores a value supplied from outside, replaces a different one, and writes nothing for the same one", async () => {
    const dir = freshDir();
    const redactor = new Redactor();
    const store = open(dir, redactor);
    expect(await store.put("keycloak-client-libredb-studio", "site-secret-1")).toBe(true);
    expect(redactor.redact("site-secret-1")).not.toContain("site-secret-1");
    const file = join(dir, SECRET_STORE_FILE);
    const written = statSync(file).mtimeMs;
    expect(await store.put("keycloak-client-libredb-studio", "site-secret-1")).toBe(false);
    expect(statSync(file).mtimeMs).toBe(written);
    expect(await store.put("keycloak-client-libredb-studio", "site-secret-2")).toBe(true);
    expect(await store.get(["keycloak-client-libredb-studio"])).toEqual({ "keycloak-client-libredb-studio": "site-secret-2" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("put refuses an invalid name and an empty value before the store is touched", async () => {
    const dir = freshDir();
    const store = open(dir);
    await expect(store.put("Bad Name", "value")).rejects.toThrow(SecretStoreError);
    await expect(store.put("good-name", "")).rejects.toThrow("refuses an empty value for good-name");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("FileSecretStore seal keys", () => {
  test("ensureSealKey issues one live key, once", async () => {
    const dir = freshDir();
    const issued = await open(dir).ensureSealKey();

    expect(issued).toEqual([
      {
        kid: expect.stringMatching(/^[0-9a-f]{16}$/),
        publicKey: expect.stringMatching(GENERATED),
        privateKey: expect.stringMatching(GENERATED),
        state: "live",
      },
    ]);
    expect(await open(dir).ensureSealKey()).toEqual(issued);
  });

  test("issued seal keys are append-only, and retiring a key keeps it as retired", async () => {
    const dir = freshDir();
    const [first] = await open(dir).ensureSealKey();
    if (first === undefined) throw new Error("expected a seal key");
    const second = await open(dir).issueSealKey();

    expect(await open(dir).retireSealKey(first.kid)).toBe(true);
    expect(await open(dir).retireSealKey(first.kid)).toBe(false);
    expect(await open(dir).sealKeys()).toEqual([{ ...first, state: "retired" }, second]);
    // A store that has issued a key never issues a first one again, even when every key is retired.
    await open(dir).retireSealKey(second.kid);
    expect(await open(dir).ensureSealKey()).toHaveLength(2);
    expect((await storeError(() => open(dir).retireSealKey("0123456789abcdef"))).message).toContain(
      "holds no seal key with kid 0123456789abcdef",
    );
  });

  test("issueSealKey refuses a 17th live key, the limit of Studio's keyring", async () => {
    const dir = freshDir();
    const store = open(dir);
    const issued = [];
    for (let index = 0; index < 16; index += 1) issued.push(await store.issueSealKey());

    expect((await storeError(() => store.issueSealKey())).message).toContain("already holds 16 live seal keys");

    await store.retireSealKey(issued[0]?.kid ?? "");
    await store.issueSealKey();
    const sealKeys = await store.sealKeys();
    expect(sealKeys).toHaveLength(17);
    expect(sealKeys.filter((key) => key.state === "live")).toHaveLength(16);
  });
});

describe("FileSecretStore fingerprints", () => {
  test("hold the SHA-256 of each value and the kid and state of each seal key, and no secret", async () => {
    const dir = freshDir();
    writeStore(dir, {
      version: 1,
      values: { alpha: "value-one" },
      sealKeys: [
        { ...ALICE, state: "live" },
        { ...BOB, state: "retired" },
      ],
    });

    const fingerprints = await open(dir).fingerprints();

    expect(fingerprints).toEqual({
      values: { alpha: "ed38523aac9a5d0c93ae804f7066af9502da3f33b334ba17a97bc932cc7781a5" },
      sealKeys: [
        { kid: "300c9c9603b92a4b", state: "live" },
        { kid: "f35e5616160a30bf", state: "retired" },
      ],
    });
    const text = JSON.stringify(fingerprints);
    for (const secret of ["value-one", ALICE.privateKey, BOB.privateKey]) expect(text).not.toContain(secret);
  });
});

describe("FileSecretStore file checks", () => {
  test("refuses a store file that group or others can access", async () => {
    const dir = freshDir();
    const file = writeStore(dir, { version: 1, values: {}, sealKeys: [] });
    chmodSync(file, 0o640);

    expect((await storeError(() => open(dir).sealKeys())).message).toContain(`${file} has mode 0640`);
  });

  test("refuses a corrupt store file, naming the problem and never a value", async () => {
    const live = (key: typeof ALICE) => ({ ...key, state: "live" });
    const keys = (...sealKeys: object[]) => ({ version: 1, values: {}, sealKeys });
    const cases: [unknown, string][] = [
      ["not json SECRETVALUE", "(root): not valid JSON"],
      [{ version: 2, values: {}, sealKeys: [] }, "version: Invalid input: expected 1"],
      [{ version: 1, values: [], sealKeys: [] }, "values: expected an object that maps secret names to values"],
      [{ version: 1, values: { Alpha: "SECRETVALUE" }, sealKeys: [] }, 'values.Alpha: invalid secret name "Alpha"'],
      [JSON.parse('{"version":1,"values":{"__proto__":"SECRETVALUE"},"sealKeys":[]}'), "invalid secret name"],
      [{ version: 1, values: { alpha: "" }, sealKeys: [] }, "values.alpha: expected a non-empty string"],
      [{ version: 1, values: { alpha: 7 }, sealKeys: [] }, "values.alpha: expected a non-empty string"],
      [keys({ ...live(ALICE), privateKey: "SECRETVALUE" }), "sealKeys[0].privateKey: not the base64url"],
      [keys({ ...live(ALICE), kid: BOB.kid }), "sealKeys[0]: kid and publicKey do not match privateKey"],
      [keys({ ...live(ALICE), publicKey: BOB.publicKey }), "sealKeys[0]: kid and publicKey do not match privateKey"],
      [keys(live(ALICE), live(BOB), live(ALICE)), "sealKeys[2].kid: kid 300c9c9603b92a4b appears twice"],
      [keys({ ...live(ALICE), state: "lost" }), "sealKeys[0].state: Invalid option"],
      [keys({ ...live(ALICE), extra: "SECRETVALUE" }), 'sealKeys[0]: Unrecognized key: "extra"'],
    ];
    for (const [content, problem] of cases) {
      const dir = freshDir();
      const file = writeStore(dir, content);
      const error = await storeError(() => open(dir).sealKeys());
      expect(error.message).toStartWith(`${file} is not a valid secret store:`);
      expect(error.message).toContain(problem);
      expect(error.message).not.toContain("SECRETVALUE");
      expect(error.message).not.toContain(ALICE.privateKey);
    }
  });

  test("refuses a store path that is not a regular file, and reports a store it cannot open", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, SECRET_STORE_FILE), { recursive: true, mode: 0o700 });
    expect((await storeError(() => open(dir).sealKeys())).message).toContain(
      `${join(dir, SECRET_STORE_FILE)} is not a regular file`,
    );

    const notADirectory = join(root, `plain-file-${counter}`);
    writeFileSync(notADirectory, "");
    expect((await storeError(() => open(notADirectory).sealKeys())).message).toContain(
      `cannot read ${join(notADirectory, SECRET_STORE_FILE)}`,
    );
  });

  test("writeFileAtomic replaces a file with mode 0600 and leaves no temporary file when the rename fails", () => {
    const dir = freshDir();
    const file = join(dir, "state.json");
    writeFileAtomic(file, "first");
    writeFileAtomic(file, "second");
    expect(readFileSync(file, "utf8")).toBe("second");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["state.json"]);

    const target = join(dir, "occupied");
    mkdirSync(join(target, "child"), { recursive: true });
    expect(() => writeFileAtomic(target, "text")).toThrow(`cannot write ${target}`);
    expect(readdirSync(dir).sort()).toEqual(["occupied", "state.json"]);
  });
});
