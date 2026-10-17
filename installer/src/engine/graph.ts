// Runs the steps in graph order, the order of STEP_NAMES. `applyGraph` observes, plans and applies each step and saves
// the state after every step, so a failure keeps what the earlier steps saved; `planGraph` only observes and plans.
import { createHash } from "node:crypto";
import { ExitCode } from "../cli/exit-codes";
import { checkImmutable, type ImmutableFields } from "../state/immutable";
import type { InstallerState, StateStore } from "../state/store";
import { STEP_NAMES, type Action, type Step, type StepName, type StepRun } from "./step";

export interface GraphOptions<C> {
  /** The steps of this installer build, in any order; the graph runs them in the order of STEP_NAMES. */
  readonly steps: readonly Step<C>[];
  readonly store: StateStore;
  /** Handed to every step, such as the configuration and the adapters. */
  readonly context: C;
  /** The immutable fields of the configuration, compared with those the installation was created with. */
  readonly installation: ImmutableFields;
  /** When set, run only these steps, still in graph order. */
  readonly only?: readonly string[];
  /** The clock of the step records. */
  readonly now?: () => Date;
}

/** The actions a step planned in this run; empty when the step found nothing to change. */
export interface StepPlan {
  readonly name: StepName;
  readonly actions: readonly Action[];
}

/** A step selection that names no step or a step this installer build does not have. */
export class StepSelectionError extends Error {
  readonly exitCode = ExitCode.InvalidUsage;

  constructor(message: string) {
    super(message);
    this.name = "StepSelectionError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// JSON with sorted object keys, so equal inputs give equal text whatever order their keys were set in.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  // Name the type only, so the message never quotes a value or a function's source.
  const found = typeof value === "number" ? String(value) : Object.prototype.toString.call(value).slice(8, -1);
  throw new TypeError(`step inputs must be JSON values, and ${found} is not one`);
}

/** The SHA-256 hex digest of the inputs as canonical JSON. */
export function hashInputs(inputs: unknown): string {
  return createHash("sha256").update(canonicalJson(inputs)).digest("hex");
}

function selectSteps<C>(steps: readonly Step<C>[], only: readonly string[] | undefined): Step<C>[] {
  const byName = new Map<string, Step<C>>();
  for (const step of steps) {
    if (byName.has(step.name)) throw new Error(`step ${step.name} is registered twice`);
    byName.set(step.name, step);
  }
  const ordered = STEP_NAMES.flatMap((name) => byName.get(name) ?? []);
  if (only === undefined) return ordered;
  const available = `the steps are ${ordered.map((step) => step.name).join(", ")}`;
  const unknown = only.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new StepSelectionError(`unknown step${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; ${available}`);
  }
  if (only.length === 0) throw new StepSelectionError(`no step selected; ${available}`);
  return ordered.filter((step) => only.includes(step.name));
}

async function begin<C>(options: GraphOptions<C>): Promise<{ steps: Step<C>[]; state: InstallerState }> {
  const steps = selectSteps(options.steps, options.only);
  const state = await options.store.load();
  if (state.installation !== undefined) checkImmutable(state.installation, options.installation);
  return { steps, state };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runOf<C>(step: Step<C>, state: InstallerState, context: C): StepRun<C> {
  return { context, state, inputHash: hashInputs(step.inputs(context)) };
}

/** Observes and plans the selected steps without applying anything or saving the state. */
export async function planGraph<C>(options: GraphOptions<C>): Promise<StepPlan[]> {
  const { steps, state } = await begin(options);
  const plans: StepPlan[] = [];
  for (const step of steps) {
    const run = runOf(step, state, options.context);
    plans.push({ name: step.name, actions: await step.plan(await step.observe(run), run) });
  }
  return plans;
}

/**
 * Observes, plans and applies the selected steps in graph order and saves the state after every step.
 * A step with an empty plan is not applied. A failed step is recorded as failed, the state is saved with what the
 * step recorded before it failed, and the step's error is rethrown, so the steps after it never run.
 */
export async function applyGraph<C>(options: GraphOptions<C>): Promise<StepPlan[]> {
  const now = options.now ?? (() => new Date());
  const { steps, state } = await begin(options);
  const applied: StepPlan[] = [];
  for (const step of steps) {
    try {
      const run = runOf(step, state, options.context);
      const actions = await step.plan(await step.observe(run), run);
      if (actions.length > 0) {
        // The first applied action creates the installation, which fixes its immutable fields even if it fails.
        state.installation ??= { ...options.installation };
        await step.apply(actions, run);
      }
      state.steps[step.name] = {
        result: actions.length > 0 ? "applied" : "unchanged",
        finishedAt: now().toISOString(),
        inputHash: run.inputHash,
      };
      applied.push({ name: step.name, actions });
    } catch (error) {
      state.steps[step.name] = { result: "failed", finishedAt: now().toISOString() };
      try {
        await options.store.save(state);
      } catch (saveError) {
        throw new AggregateError(
          [error, saveError],
          `${step.name} failed: ${messageOf(error)}; saving the state then failed too: ${messageOf(saveError)}`,
        );
      }
      throw error;
    }
    await options.store.save(state);
  }
  return applied;
}
