// Reads what the base and deploy steps need from the rendered compose.yaml: the images its services run, one
// service's definition, and the networks Compose expects under the project's name.
import { parse } from "yaml";
import type { Action } from "../engine/step";
import { COMPOSE_PROJECT } from "../render/compose";

interface ComposeDocument {
  services?: Record<string, { image?: unknown }>;
  networks?: Record<string, { internal?: unknown } | null>;
}

function documentOf(composeYaml: string): ComposeDocument {
  return parse(composeYaml) as ComposeDocument;
}

/** The image of every service, once each, in service order. */
export function composeImages(composeYaml: string): string[] {
  const images = new Set<string>();
  for (const [name, service] of Object.entries(documentOf(composeYaml).services ?? {})) {
    if (typeof service.image !== "string") throw new Error(`service ${name} has no image`);
    images.add(service.image);
  }
  return [...images];
}

/** One service's definition as a JSON value, so a step can record its hash. */
export function serviceDefinition(composeYaml: string, service: string): unknown {
  const definition = documentOf(composeYaml).services?.[service];
  if (definition === undefined) throw new Error(`the rendered compose file has no service ${service}`);
  return definition;
}

/** A network of the project, by the name Docker gives it: `<project>_<key>`. */
export interface NetworkSpec {
  key: string;
  name: string;
  internal: boolean;
}

export function composeNetworks(composeYaml: string, project: string = COMPOSE_PROJECT): NetworkSpec[] {
  return Object.entries(documentOf(composeYaml).networks ?? {}).map(([key, network]) => ({
    key,
    name: `${project}_${key}`,
    internal: network?.internal === true,
  }));
}

/** A Docker network as `docker network inspect` reports it. */
export interface ObservedNetwork {
  name: string;
  internal: boolean;
  labels: Record<string, string>;
}

export interface NetworkAction extends Action {
  kind: "network";
  network: NetworkSpec;
  /** The labels Compose looks for, so `docker compose up` adopts the network instead of refusing it. */
  labels: Record<string, string>;
}

/** The project's network is not one this installation can use. */
export class NetworkConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkConflictError";
  }
}

/** Plans the creation of each missing network, and refuses one that exists with other settings or another owner. */
export function planNetworks(
  desired: readonly NetworkSpec[],
  observed: readonly ObservedNetwork[],
  project: string = COMPOSE_PROJECT,
): NetworkAction[] {
  const actions: NetworkAction[] = [];
  for (const network of desired) {
    const labels = { "com.docker.compose.project": project, "com.docker.compose.network": network.key };
    const found = observed.find((candidate) => candidate.name === network.name);
    if (found === undefined) {
      const summary = `create ${network.internal ? "internal " : ""}network ${network.name}`;
      actions.push({ kind: "network", network, labels, summary });
      continue;
    }
    const owner = found.labels["com.docker.compose.project"];
    if (owner !== project || found.labels["com.docker.compose.network"] !== network.key) {
      throw new NetworkConflictError(
        `network ${network.name} exists but does not belong to the Compose project ${project}; remove or rename it`,
      );
    }
    if (found.internal !== network.internal) {
      throw new NetworkConflictError(
        `network ${network.name} exists with internal ${found.internal}, and the installation needs internal ` +
          `${network.internal}; remove it while no container uses it and apply again`,
      );
    }
  }
  return actions;
}
