import { describe, expect, test } from "bun:test";
import { formatLogLine, Redactor } from "../../../src/log/redact";

const TIME = new Date("2026-10-15T12:00:00.000Z");

// A generated secret, a customer password that JSON escapes, and a multi-line private key. The secret is Bob's X25519
// private key from RFC 7748 section 6.1 as base64url, and the PEM wraps Alice's, so both are public test vectors.
const GENERATED = "XasIfmJKikt54X-Lg4AO5m87sSkmGLb9HC-LJ_-I4Os";
const QUOTED = 'pa"ss\\word';
const PEM_BODY = "MC4CAQAwBQYDK2VuBCIEIHcHbQpzGKV9PBbBclGyZkXfTC+H68CZKrF3+6UduSwq";
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----\n`;

describe("formatLogLine", () => {
  test("a registered secret never appears in a formatted log line", () => {
    const redactor = new Redactor();
    for (const secret of [GENERATED, QUOTED, PEM]) redactor.register(secret);

    const line = formatLogLine(
      { time: TIME, level: "info", message: `generated ${GENERATED}, read ${QUOTED} and the key ${PEM}` },
      redactor,
    );

    expect(line).toBe(
      '{"time":"2026-10-15T12:00:00.000Z","level":"info","msg":"generated [REDACTED], read [REDACTED] and the key [REDACTED]"}\n',
    );
    for (const form of [GENERATED, QUOTED, 'pa\\"ss\\\\word', PEM_BODY]) expect(line).not.toContain(form);
  });

  test("a message without a registered secret is kept on one line", () => {
    const redactor = new Redactor();
    redactor.register(GENERATED);

    const line = formatLogLine(
      { time: TIME, level: "error", message: 'psql failed:\nrole "x" does not exist' },
      redactor,
    );

    expect(line).toBe(
      '{"time":"2026-10-15T12:00:00.000Z","level":"error","msg":"psql failed:\\nrole \\"x\\" does not exist"}\n',
    );
  });
});

describe("Redactor", () => {
  test("masks every occurrence, and overlapping secrets as one range", () => {
    const redactor = new Redactor();
    redactor.register("abcd");
    redactor.register("cdef");

    expect(redactor.redact("xxabcdefyy abcd cdef")).toBe("xx[REDACTED]yy [REDACTED] [REDACTED]");
  });

  test("a secret that contains a shorter one is masked whole", () => {
    const redactor = new Redactor();
    redactor.register("secret");
    redactor.register("secret-longer");

    expect(redactor.redact("a secret-longer b")).toBe("a [REDACTED] b");
  });

  test("each line of a multi-line secret is masked on its own, and its blank lines are not registered", () => {
    const redactor = new Redactor();
    redactor.register("first-line-secret\r\nsecond-line-secret\n\n  \n");

    expect(redactor.redact("out: second-line-secret")).toBe("out: [REDACTED]");
    expect(redactor.redact("first-line-secret")).toBe("[REDACTED]");
    expect(redactor.redact("a\n\n  \nb")).toBe("a\n\n  \nb");
  });

  test("text without a registered secret is returned unchanged", () => {
    const redactor = new Redactor();
    expect(redactor.redact("nothing to hide")).toBe("nothing to hide");
    redactor.register(GENERATED);
    expect(redactor.redact("nothing to hide")).toBe("nothing to hide");
  });

  test("an empty value cannot be registered", () => {
    expect(() => new Redactor().register("")).toThrow("cannot register an empty secret value");
  });
});
