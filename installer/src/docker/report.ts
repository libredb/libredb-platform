// The text the plan, apply and status commands print. It holds step names, action summaries, container states and
// the lock holder, never a secret value.
import type { ComposeContainer } from "../adapters/docker";
import type { StepPlan } from "../engine/graph";
import type { StepName } from "../engine/step";
import type { LockFile } from "../state/lock";
import type { InstallerState } from "../state/store";

export const NO_CHANGES = "No changes";

export function changeCount(plans: readonly StepPlan[]): number {
  return plans.reduce((total, plan) => total + plan.actions.length, 0);
}

/** One block per step with changes and a total, or `No changes` when every step found the host converged. */
export function formatPlan(plans: readonly StepPlan[]): string {
  const changes = changeCount(plans);
  if (changes === 0) return `${NO_CHANGES}\n`;
  const lines: string[] = [];
  for (const plan of plans) {
    if (plan.actions.length === 0) continue;
    lines.push(`${plan.name}:`, ...plan.actions.map((action) => `  - ${action.summary}`));
  }
  const steps = plans.filter((plan) => plan.actions.length > 0).length;
  lines.push(`${changes} change${changes === 1 ? "" : "s"} in ${steps} step${steps === 1 ? "" : "s"}`);
  return `${lines.join("\n")}\n`;
}

function columns(rows: readonly string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)));
  return rows.map((row) => `  ${row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] as number))).join("  ")}`);
}

/** One certificate of the installation and when it expires. */
export interface CertificateStatus {
  /** Names the certificate, such as `internal CA`, a public hostname or `postgres`. */
  name: string;
  notAfter: Date;
}

const DAY_MS = 86_400_000;

export interface StatusInput {
  /** The steps of this installer build, in graph order. */
  steps: readonly StepName[];
  state: InstallerState;
  lock: LockFile | undefined;
  /** The project's containers, or undefined when no compose file was rendered yet. */
  containers: readonly ComposeContainer[] | undefined;
  /** The internal CA and every leaf found on the host. */
  certificates: readonly CertificateStatus[];
  now: Date;
}

export function formatStatus(input: StatusInput): string {
  const lines = ["Steps:"];
  lines.push(
    ...columns(
      input.steps.map((name) => {
        const record = input.state.steps[name];
        return record === undefined ? [name, "never run"] : [name, record.result, record.finishedAt];
      }),
    ),
  );
  const owner = input.lock?.owner;
  if (input.lock === undefined) lines.push("Lock: free");
  else if (owner === undefined) lines.push("Lock: present, but it does not name the run that holds it");
  else lines.push(`Lock: held by pid ${owner.pid} on ${owner.host} since ${owner.since}`);
  if (input.containers === undefined) {
    lines.push("Containers: none, because no compose file was rendered yet");
  } else if (input.containers.length === 0) {
    lines.push("Containers: none");
  } else {
    lines.push("Containers:");
    lines.push(
      ...columns(
        input.containers.map((container) => [
          container.service,
          container.state,
          container.health === "" ? "no healthcheck" : container.health,
        ]),
      ),
    );
  }
  if (input.certificates.length === 0) {
    lines.push("Certificates: none, because the tls step has not issued any yet");
  } else {
    lines.push("Certificates:");
    lines.push(
      ...columns(
        input.certificates.map((certificate) => [
          certificate.name,
          `expires ${certificate.notAfter.toISOString()}`,
          `${Math.floor((certificate.notAfter.getTime() - input.now.getTime()) / DAY_MS)} days left`,
        ]),
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
