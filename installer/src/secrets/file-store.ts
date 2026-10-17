// The secret store as one JSON document in a directory (/opt/libredb/secrets in Docker mode), accessible by
// its owner only and replaced atomically, so a crash leaves either the old or the new document.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { formatPath } from "../config/schema";
import type { Redactor } from "../log/redact";
import { generateSecret } from "./generate";
import { MAX_KEYRING_KEYS } from "./keyring";
import { generateSealKeyPair, isRawSealKey, sealKeyPairFromPrivateKey } from "./seal-keys";
import {
  invalidSecretName,
  isSecretName,
  type SealKeyRecord,
  type SecretFingerprints,
  type SecretStore,
  SecretStoreError,
  secretFingerprint,
} from "./store";

export const SECRET_STORE_FILE = "secrets.json";

/**
 * Replaces a file through a temporary sibling and a rename, creating its directory with mode 0700.
 * The file gets mode 0600.
 */
export function writeFileAtomic(file: string, text: string): void {
  const dir = dirname(file);
  const temporary = join(dir, `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(temporary, "wx", 0o600);
    try {
      // The umask can only narrow the mode given to open, so set it exactly.
      fchmodSync(fd, 0o600);
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    // Persist the rename itself.
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new SecretStoreError(`cannot write ${file}: ${(error as Error).message}`);
  }
}

/** Reads the store file, or returns undefined when it does not exist yet. */
function readStoreFile(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SecretStoreError(`cannot read ${file}: ${(error as Error).message}`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new SecretStoreError(`${file} is not a regular file`);
    if ((stats.mode & 0o077) !== 0) {
      const mode = (stats.mode & 0o777).toString(8).padStart(4, "0");
      throw new SecretStoreError(
        `${file} has mode ${mode}, and a secret store must be accessible by its owner only (mode 0600)`,
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

interface StoreDocument {
  values: Map<string, string>;
  sealKeys: SealKeyRecord[];
}

const storeFile = z
  .object({
    version: z.literal(1),
    // Validated entry by entry below: a record schema would drop a "__proto__" key without an issue.
    values: z.custom<Record<string, unknown>>(
      (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      "expected an object that maps secret names to values",
    ),
    sealKeys: z.array(
      z
        .object({
          kid: z.string(),
          publicKey: z.string(),
          privateKey: z.string(),
          state: z.enum(["live", "retired"]),
        })
        .strict(),
    ),
  })
  .strict();

function invalidStore(file: string, issues: readonly string[]): SecretStoreError {
  const lines = issues.map((issue) => `  ${issue}`).join("\n");
  return new SecretStoreError(`${file} is not a valid secret store:\n${lines}`);
}

/** Validates a store document. Issues name paths and kids, never a value or a key. */
function parseStoreDocument(text: string, file: string): StoreDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message can quote the content, and the content holds secrets.
    throw invalidStore(file, ["(root): not valid JSON"]);
  }
  const parsed = storeFile.safeParse(raw);
  if (!parsed.success) {
    throw invalidStore(file, parsed.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`));
  }
  const issues: string[] = [];
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed.data.values)) {
    const path = formatPath(["values", name]);
    if (!isSecretName(name)) issues.push(`${path}: ${invalidSecretName(name)}`);
    else if (typeof value !== "string" || value === "") issues.push(`${path}: expected a non-empty string`);
    else values.set(name, value);
  }
  const kids = new Set<string>();
  for (const [index, entry] of parsed.data.sealKeys.entries()) {
    if (!isRawSealKey(entry.privateKey)) {
      issues.push(
        `${formatPath(["sealKeys", index, "privateKey"])}: not the base64url of a raw 32-byte X25519 private key`,
      );
      continue;
    }
    const derived = sealKeyPairFromPrivateKey(entry.privateKey);
    if (derived.kid !== entry.kid || derived.publicKey !== entry.publicKey) {
      issues.push(`${formatPath(["sealKeys", index])}: kid and publicKey do not match privateKey`);
    } else if (kids.has(entry.kid)) {
      issues.push(`${formatPath(["sealKeys", index, "kid"])}: kid ${entry.kid} appears twice`);
    } else {
      kids.add(entry.kid);
    }
  }
  if (issues.length > 0) throw invalidStore(file, issues);
  return { values, sealKeys: parsed.data.sealKeys };
}

function byName([a]: [string, string], [b]: [string, string]): number {
  return a < b ? -1 : 1;
}

function serializeStoreDocument(document: StoreDocument): string {
  const values = Object.fromEntries([...document.values].sort(byName));
  return `${JSON.stringify({ version: 1, values, sealKeys: document.sealKeys }, null, 2)}\n`;
}

function checkNames(names: readonly string[]): void {
  const invalid = names.find((name) => !isSecretName(name));
  if (invalid !== undefined) throw new SecretStoreError(invalidSecretName(invalid));
}

export interface FileSecretStoreOptions {
  /** The store directory, created with mode 0700 on the first write. */
  dir: string;
  /** Receives every value the store reads or generates. */
  redactor: Redactor;
}

/**
 * Keeps the store in `<dir>/secrets.json`. Every call reads the file, and a call that changes nothing writes nothing.
 * Generated values are never regenerated while present, and issued seal keys are never removed.
 */
export class FileSecretStore implements SecretStore {
  readonly file: string;
  readonly #redactor: Redactor;

  constructor(options: FileSecretStoreOptions) {
    this.file = join(options.dir, SECRET_STORE_FILE);
    this.#redactor = options.redactor;
  }

  async ensure<N extends string>(names: readonly N[]): Promise<Record<N, string>> {
    checkNames(names);
    const document = this.#load();
    const absent = [...new Set(names)].filter((name) => !document.values.has(name));
    for (const name of absent) {
      const value = generateSecret();
      this.#redactor.register(value);
      document.values.set(name, value);
    }
    if (absent.length > 0) this.#save(document);
    return this.#pick(document, names);
  }

  async put(name: string, value: string): Promise<boolean> {
    checkNames([name]);
    if (value === "") throw new SecretStoreError(`${this.file} refuses an empty value for ${name}`);
    this.#redactor.register(value);
    const document = this.#load();
    if (document.values.get(name) === value) return false;
    document.values.set(name, value);
    this.#save(document);
    return true;
  }

  async get<N extends string>(names: readonly N[]): Promise<Record<N, string>> {
    checkNames(names);
    return this.#pick(this.#load(), names);
  }

  async sealKeys(): Promise<SealKeyRecord[]> {
    return this.#load().sealKeys;
  }

  async ensureSealKey(): Promise<SealKeyRecord[]> {
    const document = this.#load();
    if (document.sealKeys.length === 0) {
      document.sealKeys.push(this.#newSealKey());
      this.#save(document);
    }
    return document.sealKeys;
  }

  async issueSealKey(): Promise<SealKeyRecord> {
    const document = this.#load();
    const live = document.sealKeys.filter((key) => key.state === "live").length;
    if (live >= MAX_KEYRING_KEYS) {
      throw new SecretStoreError(
        `${this.file} already holds ${live} live seal keys, the keyring limit that Studio accepts; ` +
          "retire one before issuing another",
      );
    }
    const record = this.#newSealKey();
    document.sealKeys.push(record);
    this.#save(document);
    return record;
  }

  async retireSealKey(kid: string): Promise<boolean> {
    const document = this.#load();
    const record = document.sealKeys.find((key) => key.kid === kid);
    if (record === undefined) throw new SecretStoreError(`${this.file} holds no seal key with kid ${kid}`);
    if (record.state === "retired") return false;
    record.state = "retired";
    this.#save(document);
    return true;
  }

  async fingerprints(): Promise<SecretFingerprints> {
    const document = this.#load();
    return {
      values: Object.fromEntries(
        [...document.values].sort(byName).map(([name, value]) => [name, secretFingerprint(value)]),
      ),
      sealKeys: document.sealKeys.map(({ kid, state }) => ({ kid, state })),
    };
  }

  #newSealKey(): SealKeyRecord {
    const pair = generateSealKeyPair();
    this.#redactor.register(pair.privateKey);
    return { ...pair, state: "live" };
  }

  #load(): StoreDocument {
    const text = readStoreFile(this.file);
    if (text === undefined) return { values: new Map(), sealKeys: [] };
    const document = parseStoreDocument(text, this.file);
    for (const value of document.values.values()) this.#redactor.register(value);
    for (const key of document.sealKeys) this.#redactor.register(key.privateKey);
    return document;
  }

  #save(document: StoreDocument): void {
    writeFileAtomic(this.file, serializeStoreDocument(document));
  }

  #pick<N extends string>(document: StoreDocument, names: readonly N[]): Record<N, string> {
    const absent = [...new Set(names)].filter((name) => !document.values.has(name));
    if (absent.length > 0) throw new SecretStoreError(`${this.file} holds no value for ${absent.join(", ")}`);
    return Object.fromEntries(names.map((name) => [name, document.values.get(name)])) as Record<N, string>;
  }
}
