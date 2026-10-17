// The installer state that the graph saves after every step: the immutable fields, a record per step
// with its input hash, the objects this installation created, the fingerprints of its secrets and the last five
// rendered revisions. It holds names, hashes and fingerprints only, never a secret value.
// FileStateStore keeps it in a file in Docker mode; a Kubernetes store keeps the same JSON in a Secret.
import { z } from "zod";
import { formatPath } from "../config/schema";
import { STEP_NAMES } from "../engine/step";
import { immutableFieldsSchema } from "./immutable";

export const STATE_VERSION = 1;

/** The number of rendered revisions the state keeps, the newest last. */
export const KEPT_REVISIONS = 5;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a SHA-256 hex digest");

const timestamp = z.iso.datetime();

const stepName = z.enum(STEP_NAMES);

// A step that succeeded records the hash of its inputs; a failed step records none, so the next run never
// takes its inputs for converged.
const stepRecord = z.union([
  z.object({ result: z.enum(["applied", "unchanged"]), finishedAt: timestamp, inputHash: sha256 }).strict(),
  z.object({ result: z.literal("failed"), finishedAt: timestamp }).strict(),
]);

// An object this installation created, such as a PostgreSQL role or a Docker network.
const ownershipRecord = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9-]*$/, "expected a lowercase kind such as postgres-role"),
    name: z.string().min(1),
    step: stepName,
  })
  .strict();

// What one apply rendered: each rendered file or object with the SHA-256 of its content, and the latest migration in
// platform._prisma_migrations once Platform's migrate job ran. It is a record that no command reads.
const revision = z
  .object({
    number: z.number().int().min(1),
    createdAt: timestamp,
    rendered: z.record(z.string().min(1), sha256),
    platformMigration: z.string().min(1).optional(),
  })
  .strict();

const installerState = z
  .object({
    version: z.literal(STATE_VERSION),
    installation: immutableFieldsSchema.optional(),
    steps: z.partialRecord(stepName, stepRecord),
    ownership: z.array(ownershipRecord),
    secrets: z.record(z.string().min(1), sha256),
    revisions: z.array(revision).max(KEPT_REVISIONS),
  })
  .strict();

export type InstallerState = z.output<typeof installerState>;
export type StepRecord = z.output<typeof stepRecord>;
export type OwnershipRecord = z.output<typeof ownershipRecord>;
export type Revision = z.output<typeof revision>;

/** Where the graph loads the state from and saves it to. */
export interface StateStore {
  /** Reads the saved state, or an empty state when none was saved yet. */
  load(): Promise<InstallerState>;
  /** Validates the state and replaces the saved one with it. */
  save(state: InstallerState): Promise<void>;
}

/** A state that cannot be read or written, with the file or object it came from. */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

export function emptyState(): InstallerState {
  return { version: STATE_VERSION, steps: {}, ownership: [], secrets: {}, revisions: [] };
}

function validate(raw: unknown, source: string): InstallerState {
  const result = installerState.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  ${formatPath(issue.path)}: ${issue.message}`);
    throw new StateError(`${source}: invalid installer state:\n${issues.join("\n")}`);
  }
  return result.data;
}

/** Parses saved state; `source` names the file or object in errors, which never quote its content. */
export function parseState(text: string, source: string): InstallerState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StateError(`${source}: the state is not valid JSON`);
  }
  return validate(raw, source);
}

/** Validates the state and returns the JSON text to save, so an invalid state is never written. */
export function serializeState(state: InstallerState, target: string): string {
  return `${JSON.stringify(validate(state, target), null, 2)}\n`;
}

/** Appends the next rendered revision and drops the oldest ones beyond KEPT_REVISIONS. */
export function appendRevision(state: InstallerState, revision: Omit<Revision, "number">): Revision {
  const added: Revision = { number: (state.revisions.at(-1)?.number ?? 0) + 1, ...revision };
  state.revisions = [...state.revisions, added].slice(-KEPT_REVISIONS);
  return added;
}
