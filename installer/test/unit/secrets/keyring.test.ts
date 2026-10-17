import { describe, expect, test } from "bun:test";
import { KeyringError, renderKeyring } from "../../../src/secrets/keyring";
import { generateSealKeyPair } from "../../../src/secrets/seal-keys";
import type { SealKeyRecord, SealKeyState } from "../../../src/secrets/store";

// RFC 7748 section 6.1 keys as base64url, with their public keys and kids.
const ALICE: SealKeyRecord = {
  kid: "300c9c9603b92a4b",
  publicKey: "hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo",
  privateKey: "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo",
  state: "live",
};
const BOB: SealKeyRecord = {
  kid: "f35e5616160a30bf",
  publicKey: "3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hbeGdNrfx-FG-IK08",
  privateKey: "XasIfmJKikt54X-Lg4AO5m87sSkmGLb9HC-LJ_-I4Os",
  state: "live",
};
// Alice's key with the bits that X25519 clamps already cleared and set: other bytes, the same public key and kid.
const ALICE_CLAMPED: SealKeyRecord = { ...ALICE, privateKey: "cAdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LGo" };

function generated(count: number, state: SealKeyState = "live"): SealKeyRecord[] {
  return Array.from({ length: count }, () => ({ ...generateSealKeyPair(), state }));
}

function refusal(sealKeys: readonly SealKeyRecord[]): KeyringError {
  try {
    renderKeyring(sealKeys);
  } catch (error) {
    if (error instanceof KeyringError) return error;
    throw error;
  }
  throw new Error("expected a KeyringError");
}

describe("renderKeyring", () => {
  test("renders the live keys in issue order and leaves retired keys out", () => {
    const retired = generated(1, "retired");

    expect(renderKeyring([ALICE, ...retired, BOB])).toBe(
      '{"version":1,"keys":["dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo","XasIfmJKikt54X-Lg4AO5m87sSkmGLb9HC-LJ_-I4Os"]}',
    );
  });

  test("refuses a keyring with a duplicate kid", () => {
    for (const twin of [ALICE, ALICE_CLAMPED]) {
      const error = refusal([ALICE, BOB, twin]);
      expect(error.message).toContain("kid 300c9c9603b92a4b twice");
      expect(error.message).not.toContain(twin.privateKey);
    }
  });

  test("refuses a keyring with 17 keys, the limit of Studio's keyring", () => {
    expect(refusal(generated(17)).message).toContain("17 live seal keys, above the limit of 16");

    const sixteen = generated(16);
    const keyring = JSON.parse(renderKeyring([...generated(1, "retired"), ...sixteen])) as { keys: string[] };
    expect(keyring.keys).toEqual(sixteen.map((key) => key.privateKey));
  });

  test("refuses an empty keyring", () => {
    for (const sealKeys of [[], generated(2, "retired")]) {
      expect(refusal(sealKeys).message).toContain("no live seal key");
    }
  });

  test("refuses a key that is not 32 bytes, without naming it", () => {
    const short = Buffer.alloc(31, 9).toString("base64url");
    const error = refusal([ALICE, { ...BOB, privateKey: short }]);

    expect(error.message).toContain("live seal key 2 is not the base64url of a raw 32-byte X25519 private key");
    expect(error.message).not.toContain(short);
  });
});
