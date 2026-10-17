import { describe, expect, test } from "bun:test";
import { scramSha256Verifier } from "../../../src/secrets/scram";

// RFC 7677 section 3: user "user", password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ== and 4096 iterations.
const RFC7677_SALT = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");

describe("scramSha256Verifier", () => {
  test("returns SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU= for password pencil and the RFC 7677 salt", () => {
    expect(scramSha256Verifier("pencil", RFC7677_SALT)).toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
    );
  });

  test("derives the keys from the iteration count and the salt it is given", () => {
    // Computed independently with Python's hashlib.pbkdf2_hmac and hmac for salt bytes 0 to 15.
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index);
    expect(scramSha256Verifier("pencil", salt, 8192)).toBe(
      "SCRAM-SHA-256$8192:AAECAwQFBgcICQoLDA0ODw==$eI1E9qPUhOYZx05jCoqauAhM1bqykROi3uxPdU5871c=:a+NNdjY/qhkGdh1UQ0YE5zldslVJ0rA1ipdr9lbCgBU=",
    );
  });

  test("refuses a password that SASLprep could change, without naming it", () => {
    for (const password of ["", "pässword", "tab\there", "line\nbreak"]) {
      let message = "";
      try {
        scramSha256Verifier(password, RFC7677_SALT);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe("a SCRAM password must be non-empty printable ASCII, which SASLprep leaves unchanged");
    }
  });

  test("refuses an empty salt and an iteration count that is not a positive integer", () => {
    expect(() => scramSha256Verifier("pencil", new Uint8Array(0))).toThrow("a SCRAM salt must not be empty");
    for (const iterations of [0, -1, 1.5, Number.NaN]) {
      expect(() => scramSha256Verifier("pencil", RFC7677_SALT, iterations)).toThrow(
        `SCRAM iterations must be a positive integer, got ${iterations}`,
      );
    }
  });
});
