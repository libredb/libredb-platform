import { describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import { generateSealKeyPair, sealKeyPairFromPrivateKey } from "../../../src/secrets/seal-keys";

// RFC 7748 section 6.1: Alice's private key and Bob's keypair, as base64url of the raw 32 bytes.
const ALICE_PRIVATE = Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex").toString(
  "base64url",
);
const BOB = { d: "XasIfmJKikt54X-Lg4AO5m87sSkmGLb9HC-LJ_-I4Os", x: "3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hbeGdNrfx-FG-IK08" };

// Node's JWK import builds an X25519 private key from d alone, so x only satisfies the format.
function sharedSecret(privateKey: string, publicKey: string): string {
  const own = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: privateKey, x: publicKey }, format: "jwk" });
  const peer = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: publicKey }, format: "jwk" });
  return diffieHellman({ privateKey: own, publicKey: peer }).toString("hex");
}

describe("seal keys", () => {
  test("derives public key 8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a and kid 300c9c9603b92a4b from the RFC 7748 section 6.1 private key 77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", () => {
    const pair = sealKeyPairFromPrivateKey(ALICE_PRIVATE);

    expect(Buffer.from(pair.publicKey, "base64url").toString("hex")).toBe(
      "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
    );
    expect(pair.kid).toBe("300c9c9603b92a4b");
    expect(pair.privateKey).toBe(ALICE_PRIVATE);
  });

  test("a generated keypair holds raw 32-byte keys that agree on a shared secret, and the kid of its public key", () => {
    const pair = generateSealKeyPair();

    expect(pair.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.kid).toBe(
      createHash("sha256").update(Buffer.from(pair.publicKey, "base64url")).digest("hex").slice(0, 16),
    );
    // Both directions agree only when the public key belongs to the private key.
    expect(sharedSecret(pair.privateKey, BOB.x)).toBe(sharedSecret(BOB.d, pair.publicKey));
    expect(generateSealKeyPair().privateKey).not.toBe(pair.privateKey);
  });

  test("refuses a private key that is not the canonical base64url of 32 bytes, without naming it", () => {
    const refused = [
      "",
      Buffer.alloc(31, 7).toString("base64url"),
      Buffer.alloc(33, 7).toString("base64url"),
      `${ALICE_PRIVATE}=`,
      // A character of the standard base64 alphabet, which base64url does not use.
      `+${ALICE_PRIVATE.slice(1)}`,
      // The same 32 bytes with a non-zero padding bit in the last character.
      `${ALICE_PRIVATE.slice(0, -1)}p`,
    ];
    for (const privateKey of refused) {
      let message = "";
      try {
        sealKeyPairFromPrivateKey(privateKey);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("a seal private key must be the base64url of a raw 32-byte X25519 private key");
    }
  });
});
