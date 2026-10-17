// The step interface of the installer graph: every step observes the live system, plans the actions
// that converge it on the configuration, and applies them.
import type { InstallerState } from "../state/store";

/** The fifteen steps of the graph, in the order it runs them. */
export const STEP_NAMES = [
  "preflight",
  "images",
  "secrets",
  "tls",
  "base",
  "edge-deploy",
  "postgres-deploy",
  "postgres-provision",
  "keycloak-deploy",
  "keycloak-configure",
  "platform-migrate",
  "platform-deploy",
  "studio-deploy",
  "verify",
  "report",
] as const;

export type StepName = (typeof STEP_NAMES)[number];

/** One change a step makes to the live system. */
export interface Action {
  /** One line for the plan and the run log, such as "create network libredb_edge". It never holds a secret value. */
  readonly summary: string;
}

/** What the graph hands a step for one run. */
export interface StepRun<C> {
  /** What the caller passed to the graph, such as the configuration and the adapters. */
  readonly context: C;
  /**
   * The installer state, which the graph saves after the step, also when the step fails.
   * A step records here the objects it creates and the fingerprints of the secrets it writes.
   * While the step runs, `state.steps[name]` still holds its record from the previous run.
   */
  readonly state: InstallerState;
  /** SHA-256 of the step's inputs in this run, which the graph records when the step succeeds. */
  readonly inputHash: string;
}

/**
 * A step of the graph. `plan` returns no action when the live system already matches the configuration,
 * and the graph then never calls `apply`, so an unchanged re-run changes nothing.
 */
export interface Step<C, O = unknown, A extends Action = Action> {
  readonly name: StepName;
  /**
   * The JSON value the step converges on, such as its part of the configuration and the fingerprints of the
   * secrets it uses, never a secret value. The graph records its hash, so a later run can tell whether it changed.
   */
  inputs(context: C): unknown;
  /** Reads the live system without changing it. */
  observe(run: StepRun<C>): O | Promise<O>;
  /** Decides the actions from what `observe` found, without side effects. */
  plan(observed: O, run: StepRun<C>): readonly A[] | Promise<readonly A[]>;
  /** Performs the planned actions in order. */
  apply(actions: readonly A[], run: StepRun<C>): void | Promise<void>;
}
