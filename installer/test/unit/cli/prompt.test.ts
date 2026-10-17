import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { MaskedLine, promptSecret, PromptCancelledError } from "../../../src/cli/prompt";

/** A terminal on stdin that records raw mode, as a TTY ReadStream does. */
class FakeTerminal extends EventEmitter {
  readonly isTTY: boolean;
  isRaw = false;
  readonly modes: boolean[] = [];
  paused = false;

  constructor(isTTY = true) {
    super();
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.modes.push(mode);
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }
}

function terminal(isTTY = true) {
  const input = new FakeTerminal(isTTY);
  let written = "";
  const output = { write: (text: string) => (written += text) };
  return { input, output, written: () => written, stream: input as unknown as NodeJS.ReadStream };
}

describe("MaskedLine", () => {
  test("echoes one asterisk per character, never the character, and ends on Enter", () => {
    const line = new MaskedLine();
    expect(line.feed("s3cr")).toEqual({ echo: "****" });
    expect(line.feed("ét\r")).toEqual({ echo: "**\n", done: "enter" });
    expect(line.value).toBe("s3crét");
  });

  test("Backspace deletes the last character, and does nothing on an empty line", () => {
    const line = new MaskedLine();
    expect(line.feed("\u007fab\u007f\bc")).toEqual({ echo: "**\b \b\b \b*" });
    expect(line.value).toBe("c");
  });

  test("Ctrl-C and Ctrl-D cancel the line", () => {
    expect(new MaskedLine().feed("ab\u0003")).toEqual({ echo: "**\n", done: "cancel" });
    expect(new MaskedLine().feed("\u0004")).toEqual({ echo: "\n", done: "cancel" });
  });

  test("drops control characters and escape sequences such as an arrow key's, also across chunks", () => {
    const line = new MaskedLine();
    expect(line.feed("a\u001b[A\tb\u001bOD")).toEqual({ echo: "**" });
    expect(line.feed("\u001b[1;")).toEqual({ echo: "" });
    expect(line.feed("5Cc\u001bx")).toEqual({ echo: "*" });
    expect(line.feed("d\n")).toEqual({ echo: "*\n", done: "enter" });
    expect(line.value).toBe("abcd");
  });
});

describe("promptSecret", () => {
  test("asks on the terminal in raw mode, masks what is typed and restores the mode", async () => {
    const io = terminal();
    const answer = promptSecret("Password: ", { input: io.stream, output: io.output });
    io.input.emit("data", Buffer.from("pa"));
    io.input.emit("data", "ss\r");
    expect(await answer).toBe("pass");
    expect(io.written()).toBe("Password: ****\n");
    expect(io.input.modes).toEqual([true, false]);
    expect(io.input.paused).toBe(true);
    expect(io.input.listenerCount("data")).toBe(0);
  });

  test("rejects with PromptCancelledError on Ctrl-C", async () => {
    const io = terminal();
    const answer = promptSecret("Password: ", { input: io.stream, output: io.output });
    io.input.emit("data", "x\u0003");
    const error = await answer.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PromptCancelledError);
    expect((error as PromptCancelledError).exitCode).toBe(1);
    expect(io.input.modes).toEqual([true, false]);
  });

  test("refuses to ask without a terminal", async () => {
    const io = terminal(false);
    await expect(promptSecret("Password: ", { input: io.stream, output: io.output })).rejects.toThrow(
      "cannot ask for a secret, because stdin is not a terminal",
    );
    expect(io.written()).toBe("");
  });
});
