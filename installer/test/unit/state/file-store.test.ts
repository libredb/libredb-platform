import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileStateStore, STATE_FILE } from "../../../src/state/file-store";
import { appendRevision, emptyState, StateError, type InstallerState } from "../../../src/state/store";

const root = mkdtempSync(join(tmpdir(), "libredb-installer-state-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function freshPath(): string {
  counter += 1;
  return join(root, `case-${counter}`, "state", "state.json");
}

// sha256sum of compose-v1 and compose-v2.
const COMPOSE_V1 = "33209e07f72377c25c1add0db24751543c4e878107a1007623a3b9289d4b981c";
const COMPOSE_V2 = "18c6844ab5199260711a82b83367e977c1c152129c1e70deb252eae8b276cd49";
// sha256sum of auth-secret-value.
const AUTH_SECRET_FINGERPRINT = "41dddefb7ec683f965e05958bd50b009f8fcd425121e1bfcbc8f48df6b36923c";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function populated(): InstallerState {
  const state = emptyState();
  state.installation = {
    mode: "docker",
    "postgres.mode": "managed",
    "keycloak.mode": "managed",
    "keycloak.realm": "libredb",
    "postgres.database": "libredb",
    "postgres.keycloakDatabase": "keycloak",
    "postgres.roles.owner": "libredb_owner",
    "postgres.roles.platform": "libredb_platform",
    "postgres.roles.studio": "libredb_studio",
    "postgres.roles.keycloak": "libredb_keycloak",
  };
  state.steps.secrets = { result: "applied", finishedAt: "2026-10-15T08:00:00.000Z", inputHash: COMPOSE_V1 };
  state.steps.tls = { result: "failed", finishedAt: "2026-10-15T08:01:00.000Z" };
  state.ownership.push({ kind: "postgres-role", name: "libredb_owner", step: "postgres-provision" });
  state.secrets["auth-secret"] = AUTH_SECRET_FINGERPRINT;
  return state;
}

describe("FileStateStore", () => {
  test("keeps the state in /opt/libredb/state/state.json by default", () => {
    expect(new FileStateStore().path).toBe(STATE_FILE);
    expect(STATE_FILE).toBe("/opt/libredb/state/state.json");
  });

  test("state.json has mode 0600, is replaced atomically and keeps the last five revisions", async () => {
    const path = freshPath();
    const store = new FileStateStore(path);
    const state = emptyState();
    appendRevision(state, { createdAt: "2026-10-15T08:00:00.000Z", rendered: { "compose.yaml": COMPOSE_V1 } });
    await store.save(state);
    expect(mode(path)).toBe(0o600);

    const before = statSync(path).ino;
    const oldText = readFileSync(path, "utf8");
    const reader = openSync(path, "r");
    try {
      for (let minute = 1; minute <= 5; minute += 1) {
        appendRevision(state, {
          createdAt: `2026-10-15T08:0${minute}:00.000Z`,
          rendered: { "compose.yaml": COMPOSE_V2 },
        });
      }
      await store.save(state);

      // A new file took the name, and a reader of the old file still sees all of it.
      expect(statSync(path).ino).not.toBe(before);
      expect(readFileSync(reader, "utf8")).toBe(oldText);
    } finally {
      closeSync(reader);
    }
    expect(readdirSync(dirname(path))).toEqual(["state.json"]);
    expect(mode(path)).toBe(0o600);

    const loaded = await new FileStateStore(path).load();
    expect(loaded.revisions.map((revision) => revision.number)).toEqual([2, 3, 4, 5, 6]);
    expect(loaded.revisions[0]).toEqual({
      number: 2,
      createdAt: "2026-10-15T08:01:00.000Z",
      rendered: { "compose.yaml": COMPOSE_V2 },
    });
  });

  test("a missing state file loads as an empty state, and the first save creates a 0700 state directory", async () => {
    const path = freshPath();
    const store = new FileStateStore(path);
    expect(await store.load()).toEqual({ version: 1, steps: {}, ownership: [], secrets: {}, revisions: [] });
    await store.save(emptyState());
    expect(mode(dirname(path))).toBe(0o700);
  });

  test("a saved state loads back with its installation fields, step records, ownership records and fingerprints", async () => {
    const path = freshPath();
    await new FileStateStore(path).save(populated());
    expect(await new FileStateStore(path).load()).toEqual(populated());
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(JSON.stringify(populated())));
  });

  test("a secret value in place of a fingerprint is refused and the saved state stays as it was", async () => {
    const path = freshPath();
    const store = new FileStateStore(path);
    await store.save(populated());
    const saved = readFileSync(path, "utf8");

    const leaking = populated();
    const secret = "q8Xv1JrT0bWmZk3nLp6sYc2dHf9gEa4uNw7iRo5tUyA";
    leaking.secrets["auth-secret"] = secret;

    const error = await rejection(store.save(leaking));
    expect(error).toBeInstanceOf(StateError);
    expect((error as Error).message).toContain("secrets.auth-secret: expected a SHA-256 hex digest");
    expect((error as Error).message).not.toContain(secret);
    expect(readFileSync(path, "utf8")).toBe(saved);
    expect(readdirSync(dirname(path))).toEqual(["state.json"]);
  });

  test("a state that breaks the format is never written", async () => {
    const path = freshPath();
    const store = new FileStateStore(path);

    const tooManyRevisions = emptyState();
    for (let number = 1; number <= 6; number += 1) {
      tooManyRevisions.revisions.push({ number, createdAt: "2026-10-15T08:00:00.000Z", rendered: {} });
    }
    expect((await rejection(store.save(tooManyRevisions)) as Error).message).toContain("revisions:");

    const badHash = emptyState();
    badHash.steps.base = { result: "applied", finishedAt: "2026-10-15T08:00:00.000Z", inputHash: "not-a-hash" };
    expect((await rejection(store.save(badHash)) as Error).message).toContain("steps.base");

    const unknownStep = emptyState() as unknown as { steps: Record<string, unknown> };
    unknownStep.steps.deploy = { result: "failed", finishedAt: "2026-10-15T08:00:00.000Z" };
    expect(await rejection(store.save(unknownStep as unknown as InstallerState))).toBeInstanceOf(StateError);

    expect(() => statSync(path)).toThrow();
  });

  test("a corrupt state file is refused naming the file, never read as an empty state", async () => {
    const path = freshPath();
    mkdirSync(dirname(path), { recursive: true });
    const store = new FileStateStore(path);

    writeFileSync(path, "{ not json");
    const notJson = await rejection(store.load());
    expect(notJson).toBeInstanceOf(StateError);
    expect((notJson as Error).message).toBe(`${path}: the state is not valid JSON`);

    writeFileSync(path, JSON.stringify({ ...emptyState(), version: 2 }));
    const wrongVersion = await rejection(store.load());
    expect(wrongVersion).toBeInstanceOf(StateError);
    expect((wrongVersion as Error).message).toStartWith(`${path}: invalid installer state:\n  version:`);
  });

  test("a state path that cannot be read is an error, never an empty state", async () => {
    const path = freshPath();
    mkdirSync(path, { recursive: true });
    const error = await rejection(new FileStateStore(path).load());
    expect((error as NodeJS.ErrnoException).code).toBe("EISDIR");
  });

  test("a save that cannot replace the file leaves no temporary file behind", async () => {
    const path = freshPath();
    mkdirSync(path, { recursive: true });
    const error = await rejection(new FileStateStore(path).save(emptyState()));
    expect((error as NodeJS.ErrnoException).code).toBe("EISDIR");
    expect(readdirSync(dirname(path))).toEqual(["state.json"]);
    expect(statSync(path).isDirectory()).toBe(true);
  });

  test("under umask 0277 a new state file still gets mode 0600", async () => {
    const path = freshPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const previous = process.umask(0o277);
    try {
      await new FileStateStore(path).save(emptyState());
    } finally {
      process.umask(previous);
    }
    expect(mode(path)).toBe(0o600);
  });
});
