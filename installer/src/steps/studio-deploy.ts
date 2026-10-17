// Step 13 of the Docker graph: Studio's web server on networks edge and data, with its governance env of
// contracts/env-inventory.yaml in its own 0600 env file and its keyring in /opt/libredb/secrets/studio-keyring.json,
// mode 0400 and owned by the uid Studio runs as, which only the studio service mounts. Studio reads both and the CA
// bundle only at start, so a change to any of them recreates the container, whose fixed hostname and
// GOVERNANCE_INSTANCE_ID make it update the same bridge.studio_instance row as before.
import { CA_BUNDLE_FILE } from "../docker/layout";
import { serviceDefinition } from "../docker/project";
import { APP_SECRET_NAMES } from "../docker/secrets";
import type { ServiceAction } from "../docker/services";
import type { Step } from "../engine/step";
import { CLIENT_SECRET_NAMES } from "../keycloak/desired";
import {
  STUDIO_ENV_FILE,
  STUDIO_KEYRING_FILE,
  STUDIO_SERVICE,
  studioEnvFile,
  studioKeyringFile,
} from "../render/compose";
import { ROLE_SPECS } from "../sql/provision";
import {
  applyDeploy,
  composeFileSpec,
  observeDeploy,
  planDeploy,
  renderedCompose,
  type DeployAction,
  type DeployObservation,
} from "./deploy";
import { fileFingerprint, type DockerContext } from "./docker-context";
import { postgresServer, storedSecrets } from "./platform-deploy";

const RUNTIME_SECRETS = [
  ROLE_SPECS.studio.secret,
  CLIENT_SECRET_NAMES.studio,
  APP_SECRET_NAMES.studioJwtSecret,
  APP_SECRET_NAMES.studioStorageEncryptionKey,
];

/** Studio's env file as it must be, or why it cannot be rendered yet. */
async function envFile(context: DockerContext) {
  const secrets = await storedSecrets(context, RUNTIME_SECRETS);
  if ("pending" in secrets) return { path: STUDIO_ENV_FILE, pending: secrets.pending };
  return studioEnvFile(context.desired, {
    postgres: postgresServer(context),
    secrets: {
      oidcClientSecret: secrets.value(CLIENT_SECRET_NAMES.studio),
      jwtSecret: secrets.value(APP_SECRET_NAMES.studioJwtSecret),
      storageEncryptionKey: secrets.value(APP_SECRET_NAMES.studioStorageEncryptionKey),
      databasePassword: secrets.value(ROLE_SPECS.studio.secret),
    },
  });
}

/** Studio's keyring as it must be, or why it cannot be rendered yet. */
async function keyringFile(context: DockerContext) {
  const sealKeys = await context.secrets.sealKeys();
  if (!sealKeys.some((key) => key.state === "live")) {
    return { path: STUDIO_KEYRING_FILE, pending: "no live seal key is issued yet, so apply the secrets step first" };
  }
  return studioKeyringFile(sealKeys);
}

/** The files Studio reads only at start, each with the words a recreate names it by. */
const READ_AT_START = [
  { path: STUDIO_ENV_FILE, name: "env file" },
  { path: STUDIO_KEYRING_FILE, name: "keyring" },
] as const;

/** Whether the step writes the file with content the host does not hold. */
function rewritten(observed: DeployObservation, path: string): boolean {
  return observed.files.some((file) => {
    if (!("spec" in file) || file.spec.path !== path) return false;
    return file.observed?.kind !== "file" || file.observed.content !== file.spec.content;
  });
}

export const studioDeployStep: Step<DockerContext, DeployObservation, DeployAction> = {
  name: "studio-deploy",
  inputs: (context) => ({
    service: serviceDefinition(renderedCompose(context.desired), STUDIO_SERVICE),
    caBundle: fileFingerprint(CA_BUNDLE_FILE),
  }),
  observe: async ({ context }) => {
    const files = [composeFileSpec(context), await envFile(context), await keyringFile(context)];
    return observeDeploy(context, STUDIO_SERVICE, [], files);
  },
  plan(observed, run) {
    const actions = planDeploy("studio-deploy", STUDIO_SERVICE, observed, run);
    const changed = READ_AT_START.filter((file) => rewritten(observed, file.path)).map((file) => file.name);
    const service = actions.find((action): action is ServiceAction => action.kind === "service");
    // A container keeps the env file and the keyring it started with, and Compose recreates none for a new keyring, so
    // an existing container with a changed one is recreated rather than left running or only started.
    if (changed.length === 0 || observed.container === undefined || service?.recreate === true) return actions;
    const summary = `recreate ${STUDIO_SERVICE} with its changed ${changed.join(" and ")}`;
    const recreate: ServiceAction = { kind: "service", service: STUDIO_SERVICE, recreate: true, summary };
    return [...actions.filter((action) => action !== service), recreate];
  },
  apply: (actions, { context }) => applyDeploy(actions, context),
};
