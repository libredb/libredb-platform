// Masked entry of a secret on a terminal: the installer asks for a missing secret only when stdin is a
// terminal, and echoes one asterisk per character instead of the character.
import { ExitCode } from "./exit-codes";

/** The operator ended a prompt with Ctrl-C or Ctrl-D instead of entering a value. */
export class PromptCancelledError extends Error {
  readonly exitCode = ExitCode.RuntimeFailure;

  constructor() {
    super("the prompt was cancelled, so nothing was changed");
    this.name = "PromptCancelledError";
  }
}

/** What one chunk of terminal input did to a masked line: the text to echo, and whether the line ended. */
export interface MaskedStep {
  echo: string;
  done?: "enter" | "cancel";
}

const ESCAPE = "\u001b";

/**
 * One line of masked input in raw mode. Enter ends it, Ctrl-C and Ctrl-D cancel it, Backspace deletes the last
 * character, and other control characters and escape sequences, such as an arrow key's, are dropped.
 */
export class MaskedLine {
  #characters: string[] = [];
  /** Inside an escape sequence: "start" right after ESC, "csi" after its introducer. */
  #escape: "start" | "csi" | undefined;

  get value(): string {
    return this.#characters.join("");
  }

  feed(chunk: string): MaskedStep {
    let echo = "";
    for (const character of chunk) {
      if (this.#escape === "start") {
        this.#escape = character === "[" || character === "O" ? "csi" : undefined;
        continue;
      }
      if (this.#escape === "csi") {
        // A control sequence ends with its final byte, from @ to ~.
        if (character >= "@" && character <= "~") this.#escape = undefined;
        continue;
      }
      if (character === "\r" || character === "\n") return { echo: `${echo}\n`, done: "enter" };
      if (character === "\u0003" || character === "\u0004") return { echo: `${echo}\n`, done: "cancel" };
      if (character === "\u007f" || character === "\b") {
        if (this.#characters.length > 0) {
          this.#characters.pop();
          echo += "\b \b";
        }
        continue;
      }
      if (character === ESCAPE) {
        this.#escape = "start";
        continue;
      }
      if (character < " ") continue;
      this.#characters.push(character);
      echo += "*";
    }
    return { echo };
  }
}

/** The terminal a prompt reads from and writes to. */
export interface PromptTerminal {
  input: NodeJS.ReadStream;
  output: { write(text: string): unknown };
}

/** Asks for a secret on the terminal with masked entry, and resolves with what the operator typed before Enter. */
export function promptSecret(
  question: string,
  terminal: PromptTerminal = { input: process.stdin, output: process.stdout },
): Promise<string> {
  const { input, output } = terminal;
  if (input.isTTY !== true) return Promise.reject(new Error("cannot ask for a secret, because stdin is not a terminal"));
  return new Promise((resolve, reject) => {
    const line = new MaskedLine();
    const wasRaw = input.isRaw;
    const finish = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const onData = (chunk: Buffer | string) => {
      const step = line.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      output.write(step.echo);
      if (step.done === "enter") {
        finish();
        resolve(line.value);
      } else if (step.done === "cancel") {
        finish();
        reject(new PromptCancelledError());
      }
    };
    output.write(question);
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
  });
}
