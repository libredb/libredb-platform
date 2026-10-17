// What the Docker deploy steps share: the rendered compose.yaml they both own, and the observation and application
// of one Compose service with its files.
import { join } from "node:path";
import type { ComposeContainer } from "../adapters/docker";
import { applyDirectory, applyFile, observePath, readOptionalFile } from "../adapters/host-fs";
import { planDirectory, planFile, type DirectoryAction, type FileAction, type FileSpec, type ObservedPath } from "../docker/converge";
import { CA_BUNDLE_FILE, type DirectorySpec } from "../docker/layout";
import { planService, type ServiceAction } from "../docker/services";
import type { Action, StepName, StepRun } from "../engine/step";
import type { DesiredInstallation } from "../model/desired";
import { EDGE_TLS_DIR, edgeLeafFiles } from "../render/caddyfile";
import { COMPOSE_FILE, COMPOSE_PROJECT, composeTrust, renderCompose, type ComposeTrust } from "../render/compose";
import { recordedInputHash, type DockerContext } from "./docker-context";

export type DeployAction = DirectoryAction | FileAction | ServiceAction | (Action & { kind: "pending"; reason: string });

export const COMPOSE_TARGET = { project: COMPOSE_PROJECT, file: COMPOSE_FILE } as const;

/**
 * The trust labels of the CA bundle and the edge certificates as the host holds them now. An edge behind an upstream
 * proxy reads no certificate.
 */
export function hostTrust(desired: DesiredInstallation): ComposeTrust {
  const hosts = desired.edge.scheme === "https" ? desired.edge.aliases : [];
  const edgeCertificates = hosts.map((host) => ({
    host,
    pem: readOptionalFile(join(EDGE_TLS_DIR, edgeLeafFiles(host).certificate)),
  }));
  return composeTrust(readOptionalFile(CA_BUNDLE_FILE), edgeCertificates);
}

/**
 * compose.yaml as it must be now: the steps after tls and base see the final CA bundle and leaves, so every deploy
 * step writes the same file, and a service whose trust label changed differs from its recorded definition.
 */
export function renderedCompose(desired: DesiredInstallation): string {
  return renderCompose(desired, hostTrust(desired));
}

export function composeFileSpec(context: DockerContext): FileSpec {
  return { path: COMPOSE_FILE, content: renderedCompose(context.desired), mode: 0o644, uid: 0, gid: 0 };
}

/** The containers of the project, or none while no compose file exists. */
export async function projectContainers(context: DockerContext): Promise<ComposeContainer[]> {
  if (observePath(COMPOSE_FILE) === undefined) return [];
  return context.docker.ps(COMPOSE_TARGET);
}

export interface DeployObservation {
  directories: { spec: DirectorySpec; observed: ObservedPath | undefined }[];
  /** Each file the step renders; a file whose content cannot be rendered yet holds the reason instead. */
  files: ({ spec: FileSpec; observed: ObservedPath | undefined } | { pending: string; path: string })[];
  container: ComposeContainer | undefined;
}

export async function observeDeploy(
  context: DockerContext,
  service: string,
  directories: readonly DirectorySpec[],
  files: readonly (FileSpec | { pending: string; path: string })[],
): Promise<DeployObservation> {
  const containers = await projectContainers(context);
  return {
    directories: directories.map((spec) => ({ spec, observed: observePath(spec.path) })),
    files: files.map((file) => ("pending" in file ? file : { spec: file, observed: observePath(file.path) })),
    container: containers.find((container) => container.service === service),
  };
}

export function planDeploy(
  name: StepName,
  service: string,
  observed: DeployObservation,
  run: StepRun<DockerContext>,
): DeployAction[] {
  const actions: DeployAction[] = observed.directories.flatMap((entry) => planDirectory(entry.spec, entry.observed));
  for (const file of observed.files) {
    if ("pending" in file) actions.push({ kind: "pending", reason: file.pending, summary: `create ${file.path}` });
    else actions.push(...planFile(file.spec, file.observed));
  }
  actions.push(
    ...planService({
      service,
      container: observed.container,
      recordedInputHash: recordedInputHash(run.state, name),
      inputHash: run.inputHash,
    }),
  );
  return actions;
}

export async function applyDeploy(actions: readonly DeployAction[], context: DockerContext): Promise<void> {
  for (const action of actions) {
    if (action.kind === "pending") throw new Error(`cannot ${action.summary}: ${action.reason}`);
    if (action.kind === "directory") applyDirectory(action.directory);
    if (action.kind === "file") applyFile(action.file);
  }
  for (const action of actions) {
    if (action.kind === "service") {
      await context.docker.up(COMPOSE_TARGET, [action.service], { forceRecreate: action.recreate });
    }
  }
}
