// Turns the TLS plan into the actions of the Docker tls step.
import type { Action } from "../engine/step";
import type { LeafSpec, TlsPlan } from "../tls/plan";
import type { FileAction } from "./converge";

/** Creating the internal CA, issuing one of its leaves, or writing a provided chain or key to the edge. */
export type TlsAction = (Action & { kind: "ca" }) | (Action & { kind: "leaf"; leaf: LeafSpec }) | FileAction;

export function tlsActions(plan: TlsPlan): TlsAction[] {
  const actions: TlsAction[] = [];
  if (plan.ca === "create") actions.push({ kind: "ca", summary: "create the internal CA" });
  for (const leaf of plan.leaves) {
    if (leaf.action === "keep") continue;
    actions.push({
      kind: "leaf",
      leaf: { name: leaf.name, hosts: leaf.hosts },
      summary: `issue the ${leaf.name} certificate for ${leaf.hosts.join(", ")}: ${leaf.reasons.join("; ")}`,
    });
  }
  return actions;
}
