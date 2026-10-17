import { describe, expect, test } from "bun:test";
import { ExitCode } from "../../../src/cli/exit-codes";
import {
  activeSealKey,
  deleteCanaryScript,
  envelopeUsesScript,
  parseEnvelopeUses,
  planSealRotation,
  SealRotationError,
  sealKidsToRetire,
  type SealKeysConfig,
} from "../../../src/secrets/seal-rotation";
import type { SealKeyState } from "../../../src/secrets/store";

const kid = (n: number) => n.toString(16).padStart(16, "0");
const key = (n: number, state: SealKeyState = "live") => ({ kid: kid(n), state });
const config = (fields: Partial<SealKeysConfig> = {}): SealKeysConfig => ({ issueNew: false, retire: [], ...fields });

/** The error a call throws, so a test can check its class, exit code and message together. */
function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("the call threw nothing");
}

function refusal(run: () => unknown): { exitCode: number; message: string } {
  const error = thrown(run);
  expect(error).toBeInstanceOf(SealRotationError);
  return { exitCode: (error as SealRotationError).exitCode, message: error.message };
}

describe("activeSealKey", () => {
  test("is the oldest live key without activeKid, so a key issued later reaches Studio's keyring first", () => {
    expect(activeSealKey([key(1, "retired"), key(2), key(3)], undefined).kid).toBe(kid(2));
  });

  test("is the key activeKid names", () => {
    expect(activeSealKey([key(1), key(2)], kid(2)).kid).toBe(kid(2));
  });

  test("refuses with exit 6 an activeKid that names a retired key or no key at all", () => {
    for (const keys of [[key(1), key(2, "retired")], [key(1)]]) {
      const { exitCode, message } = refusal(() => activeSealKey(keys, kid(2)));
      expect(exitCode).toBe(ExitCode.UnsafeChangeRefused);
      expect(message).toContain(`bridge.sealKeys.activeKid ${kid(2)}`);
    }
  });

  test("refuses a store without a live key", () => {
    expect(() => activeSealKey([key(1, "retired")], undefined)).toThrow("the secret store holds no live seal key");
  });
});

describe("planSealRotation", () => {
  test("plans nothing without a rotation field", () => {
    expect(planSealRotation([key(1)], config(), [])).toEqual([]);
  });

  test("issueNew issues one key while the active key is the newest live key, and none once a newer key is live", () => {
    expect(planSealRotation([key(1)], config({ issueNew: true }), [])).toEqual([
      { kind: "issue-seal-key", summary: "issue a new seal key for the Studio keyring" },
    ]);
    // The second apply with the same configuration finds the key the first one issued and adds none.
    expect(planSealRotation([key(1), key(2)], config({ issueNew: true }), [])).toEqual([]);
    // A store that never issued a key issues the first one in the secrets step, and issueNew adds one after it.
    expect(planSealRotation([], config({ issueNew: true }), []).map((action) => action.kind)).toEqual(["issue-seal-key"]);
  });

  test("issueNew is refused with exit 6 when the live keyring already holds 16 kids", () => {
    const keys = Array.from({ length: 16 }, (_, index) => key(index + 1));
    const { exitCode, message } = refusal(() => planSealRotation(keys, config({ issueNew: true, activeKid: kid(16) }), []));
    expect(exitCode).toBe(ExitCode.UnsafeChangeRefused);
    expect(message).toContain("the live keyring already holds 16 kids");
    // Retiring a kid in the same apply makes room for the new one.
    expect(
      planSealRotation(keys, config({ issueNew: true, activeKid: kid(16), retire: [kid(1)] }), []).map((a) => a.kind),
    ).toEqual(["delete-seal-canary", "retire-seal-key", "issue-seal-key"]);
  });

  test("retiring a kid deletes its platform.seal_canary row in the same apply", () => {
    const actions = planSealRotation([key(1), key(2)], config({ activeKid: kid(2), retire: [kid(1)] }), []);
    expect(actions).toEqual([
      {
        kind: "delete-seal-canary",
        kid: kid(1),
        summary: `delete the seal canary of kid ${kid(1)} from platform.seal_canary as libredb_platform`,
      },
      {
        kind: "retire-seal-key",
        kid: kid(1),
        summary: `retire seal key ${kid(1)}: remove it from the Studio keyring and keep it in the secret store`,
      },
    ]);
    expect(deleteCanaryScript(kid(1))).toBe(`DELETE FROM platform.seal_canary WHERE kid = '${kid(1)}';\n`);
  });

  test("retire is refused with exit 6 while bridge.connections_v1 holds an envelope with that kid", () => {
    const uses = [
      { kid: kid(1), connectionId: "0f6c1f43-2d56-4f0e-9a3e-1c2b3d4e5f60", name: "Orders" },
      { kid: kid(1), connectionId: "7a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b", name: "Billing" },
    ];
    const { exitCode, message } = refusal(() =>
      planSealRotation([key(1), key(2)], config({ activeKid: kid(2), retire: [kid(1)] }), uses),
    );
    expect(exitCode).toBe(ExitCode.UnsafeChangeRefused);
    expect(message).toContain(`kid ${kid(1)} still seals credentials of 2 connections in bridge.connections_v1`);
    expect(message).toContain("Orders (0f6c1f43-2d56-4f0e-9a3e-1c2b3d4e5f60)");
    expect(message).toContain("Billing (7a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b)");
  });

  test("a kid that is already retired plans nothing again", () => {
    expect(planSealRotation([key(1, "retired"), key(2)], config({ retire: [kid(1)] }), [])).toEqual([]);
  });
});

describe("sealKidsToRetire", () => {
  test("names the live kids of retire, the ones whose envelopes apply must look for", () => {
    expect(sealKidsToRetire([key(1, "retired"), key(2), key(3)], config({ activeKid: kid(3), retire: [kid(1), kid(2)] }))).toEqual([
      kid(2),
    ]);
  });

  test("refuses with exit 6 to retire the active kid, also when it is the oldest live key without activeKid", () => {
    for (const fields of [{ retire: [kid(1)] }, { activeKid: kid(2), retire: [kid(2)] }]) {
      const { exitCode, message } = refusal(() => sealKidsToRetire([key(1), key(2)], config(fields)));
      expect(exitCode).toBe(ExitCode.UnsafeChangeRefused);
      expect(message).toContain("is the active kid, whose public key Platform seals with");
    }
  });

  test("refuses with exit 6 to retire a kid the secret store never issued", () => {
    const { exitCode, message } = refusal(() => sealKidsToRetire([key(1), key(2)], config({ activeKid: kid(2), retire: [kid(9)] })));
    expect(exitCode).toBe(ExitCode.UnsafeChangeRefused);
    expect(message).toContain(`the secret store issued no seal key ${kid(9)}`);
  });
});

describe("envelope uses", () => {
  test("the query reads the kid of every read and write envelope in bridge.connections_v1", () => {
    const script = envelopeUsesScript([kid(1)]);
    expect(script).toContain("FROM bridge.connections_v1");
    expect(script).toContain("split_part(read_secret, '.', 2)");
    expect(script).toContain("split_part(write_secret, '.', 2)");
    expect(script).toContain(`IN ('${kid(1)}')`);
  });

  test("parses the result line of the query", () => {
    const line = `libredb-result envelope-uses [{"kid":"${kid(1)}","connectionId":"c1","name":"Orders"}]\n`;
    expect(parseEnvelopeUses(line)).toEqual([{ kid: kid(1), connectionId: "c1", name: "Orders" }]);
  });
});
