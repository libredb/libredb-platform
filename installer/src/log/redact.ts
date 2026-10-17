// The redactor: the installer registers every secret value it reads or generates here, and every log line,
// report and state write passes through redact() before it leaves the process.

export const REDACTED = "[REDACTED]";

export class Redactor {
  readonly #needles = new Set<string>();

  /**
   * Registers a secret value. Besides the value itself it covers the form the value takes inside a JSON
   * string, and for a multi-line value each non-blank line, because subprocess output is redacted line by line.
   */
  register(value: string): void {
    if (value === "") throw new Error("cannot register an empty secret value");
    const lines = value.split(/\r\n|\r|\n/);
    const forms = lines.length > 1 ? [value, ...lines.filter((line) => line.trim() !== "")] : [value];
    for (const form of forms) {
      this.#needles.add(form);
      this.#needles.add(JSON.stringify(form).slice(1, -1));
    }
  }

  /** Replaces every range of the text that holds a registered secret, merging overlapping ranges into one mask. */
  redact(text: string): string {
    const ranges: { start: number; end: number }[] = [];
    for (const needle of this.#needles) {
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        ranges.push({ start: at, end: at + needle.length });
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    let out = "";
    let copied = 0;
    for (const { start, end } of ranges) {
      if (start >= copied) out += `${text.slice(copied, start)}${REDACTED}`;
      copied = Math.max(copied, end);
    }
    return out + text.slice(copied);
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  time: Date;
  level: LogLevel;
  message: string;
}

/**
 * Formats one record as one JSON line, redacted after serialization so that a secret is masked in the
 * escaped form JSON gives it, and so that a message with line breaks stays a single line.
 */
export function formatLogLine(record: LogRecord, redactor: Redactor): string {
  const line = JSON.stringify({ time: record.time.toISOString(), level: record.level, msg: record.message });
  return `${redactor.redact(line)}\n`;
}
