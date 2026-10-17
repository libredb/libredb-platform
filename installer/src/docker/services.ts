// Plans one Compose service of a deploy step from its container and the inputs the step recorded when it last
// converged: start what is missing or stopped, and recreate what runs with inputs that have changed since.
import type { ComposeContainer } from "../adapters/docker";
import type { Action } from "../engine/step";

export interface ServiceAction extends Action {
  kind: "service";
  service: string;
  /** Recreate the container even when Compose sees no change, because a mounted file it reads at start changed. */
  recreate: boolean;
}

export interface ServiceObservation {
  service: string;
  /** The service's container, or undefined when it has none. */
  container: ComposeContainer | undefined;
  /** The input hash the step recorded when it last succeeded, or undefined when it never did. */
  recordedInputHash: string | undefined;
  inputHash: string;
}

export function planService(observed: ServiceObservation): ServiceAction[] {
  const { service, container } = observed;
  if (container === undefined) return [{ kind: "service", service, recreate: false, summary: `start ${service}` }];
  if (observed.recordedInputHash !== observed.inputHash) {
    return [{ kind: "service", service, recreate: true, summary: `recreate ${service} with its changed configuration` }];
  }
  if (container.state !== "running" || container.health !== "healthy") {
    const health = container.health === "" ? "no health status" : container.health;
    return [{ kind: "service", service, recreate: false, summary: `start ${service}, which is ${container.state} with ${health}` }];
  }
  return [];
}

/** Reloads the configuration a running service reads, such as PostgreSQL's server certificate and pg_hba.conf. */
export interface ReloadAction extends Action {
  kind: "reload";
}

/**
 * Plans a service that reloads its mounted files without a restart, such as PostgreSQL through pg_reload_conf():
 * changed inputs on an existing container bring it up without a forced recreate, so Compose recreates it
 * only for a changed definition and the container otherwise keeps running, and then reload it. Everything else is
 * planned as planService plans it.
 */
export function planReloadableService(observed: ServiceObservation, reload: string): (ServiceAction | ReloadAction)[] {
  const actions = planService(observed);
  if (actions[0]?.recreate !== true) return actions;
  const { service } = observed;
  return [
    {
      kind: "service",
      service,
      recreate: false,
      summary: `bring ${service} up to its definition, which recreates it only when the definition itself changed`,
    },
    { kind: "reload", summary: reload },
  ];
}
