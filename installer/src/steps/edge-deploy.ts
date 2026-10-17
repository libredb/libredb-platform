// Step 6 of the Docker graph: the Caddy edge, which terminates TLS for every public hostname with the
// leaves of the TLS step. A changed Caddyfile or leaf recreates the container, because Caddy reads them at start.
import { EDGE_CONFIG_DIRECTORY, leafFiles } from "../docker/layout";
import { serviceDefinition } from "../docker/project";
import type { Step } from "../engine/step";
import { CADDYFILE, renderCaddyfile } from "../render/caddyfile";
import { desiredTls } from "../tls/plan";
import { fileFingerprint, type DockerContext } from "./docker-context";
import { applyDeploy, composeFileSpec, observeDeploy, planDeploy, renderedCompose, type DeployAction, type DeployObservation } from "./deploy";

const SERVICE = "edge";

function edgeLeaves(context: DockerContext) {
  return desiredTls(context.config).leaves.filter((leaf) => leaf.name !== "postgres");
}

export const edgeDeployStep: Step<DockerContext, DeployObservation, DeployAction> = {
  name: "edge-deploy",
  inputs: (context) => ({
    service: serviceDefinition(renderedCompose(context.desired), SERVICE),
    caddyfile: renderCaddyfile(context.desired),
    certificates: Object.fromEntries(
      edgeLeaves(context).map((leaf) => [leaf.name, fileFingerprint(leafFiles(leaf).certificate)]),
    ),
  }),
  observe: ({ context }) =>
    observeDeploy(
      context,
      SERVICE,
      [EDGE_CONFIG_DIRECTORY],
      [
        composeFileSpec(context),
        { path: CADDYFILE, content: renderCaddyfile(context.desired), mode: 0o644, uid: 0, gid: 0 },
      ],
    ),
  plan: (observed, run) => planDeploy("edge-deploy", SERVICE, observed, run),
  apply: (actions, { context }) => applyDeploy(actions, context),
};
