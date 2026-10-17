// Step 9 of the Docker graph: the managed Keycloak on networks edge and data, with its database
// password and, until the access handover, the bootstrap client in a 0600 env file. `up --wait` waits for
// /health/ready on the management port 9000, then the first run hands access over to libredb-installer
// (keycloak-handover.ts), and every later run proves the libredb-installer credentials with GET requests only.
import { observePath } from "../adapters/host-fs";
import { CA_BUNDLE_FILE } from "../docker/layout";
import { serviceDefinition } from "../docker/project";
import { POSTGRES_NAMES } from "../state/immutable";
import type { Action, Step } from "../engine/step";
import { KEYCLOAK_ENV_FILE, renderCompose } from "../render/compose";
import { generateSecret } from "../secrets/generate";
import { ROLE_SPECS } from "../sql/provision";
import { fileFingerprint, type DockerContext } from "./docker-context";
import {
  applyDeploy,
  composeFileSpec,
  observeDeploy,
  planDeploy,
  renderedCompose,
  type DeployAction,
  type DeployObservation,
} from "./deploy";
import {
  BOOTSTRAP_CLIENT_ID,
  INSTALLER_CLIENT_ID,
  INSTALLER_ENV_FILE,
  keycloakEnvContent,
  readBootstrapSecret,
  requireInstallerAccess,
  runHandover,
  type HandoverTarget,
} from "./keycloak-handover";

const SERVICE = "keycloak";
const DB_PASSWORD_SECRET = ROLE_SPECS.keycloak.secret;

export type KeycloakDeployAction = DeployAction | (Action & { kind: "handover" });

export type KeycloakDeployObservation =
  | { managed: false }
  | (DeployObservation & { managed: true; handoverPending: boolean });

const managed = (context: DockerContext) => context.desired.keycloak.managed;

export function handoverTarget(context: DockerContext): HandoverTarget {
  return {
    baseUrl: context.desired.keycloak.adminUrl,
    realm: context.desired.realm,
    keycloakEnvFile: KEYCLOAK_ENV_FILE,
    installerEnvFile: INSTALLER_ENV_FILE,
    owner: { uid: 0, gid: 0 },
    redactor: context.redactor,
    log: context.info,
  };
}

/**
 * Keycloak's env file as it must be: the database password, plus the bootstrap client while the handover is pending.
 * A missing file means a first start, which gets a new bootstrap secret; an existing one keeps its bootstrap secret,
 * or its absence once the handover removed it.
 */
async function envFile(context: DockerContext) {
  const stored = (await context.secrets.fingerprints()).values;
  if (stored[DB_PASSWORD_SECRET] === undefined) {
    return {
      spec: { path: KEYCLOAK_ENV_FILE, pending: `secret ${DB_PASSWORD_SECRET} is not generated yet, so apply the secrets step first` },
      handoverPending: true,
    };
  }
  const password = (await context.secrets.get([DB_PASSWORD_SECRET]))[DB_PASSWORD_SECRET];
  if (password === undefined) throw new Error(`the secret store did not return secret ${DB_PASSWORD_SECRET}`);
  let bootstrapSecret: string | undefined;
  if (observePath(KEYCLOAK_ENV_FILE) === undefined) {
    bootstrapSecret = generateSecret();
    context.redactor.register(bootstrapSecret);
  } else {
    bootstrapSecret = readBootstrapSecret(handoverTarget(context));
  }
  return {
    spec: { path: KEYCLOAK_ENV_FILE, content: keycloakEnvContent(password, bootstrapSecret), mode: 0o600, uid: 0, gid: 0 },
    handoverPending: bootstrapSecret !== undefined,
  };
}

export const keycloakDeployStep: Step<DockerContext, KeycloakDeployObservation, KeycloakDeployAction> = {
  name: "keycloak-deploy",
  inputs: (context) =>
    managed(context)
      ? {
          service: serviceDefinition(renderedCompose(context.desired), SERVICE),
          database: { name: POSTGRES_NAMES.keycloakDatabase, role: POSTGRES_NAMES.roles.keycloak },
          caBundle: fileFingerprint(CA_BUNDLE_FILE),
        }
      : { managed: false },
  async observe({ context }) {
    if (!managed(context)) return { managed: false };
    const env = await envFile(context);
    const observed = await observeDeploy(context, SERVICE, [], [composeFileSpec(context), env.spec]);
    const healthy = observed.container?.state === "running" && observed.container.health === "healthy";
    // After the handover, every run proves the libredb-installer credentials; a running Keycloak that refuses them
    // stops the run here instead of in a later step.
    if (!env.handoverPending && healthy) await requireInstallerAccess(handoverTarget(context));
    return { ...observed, managed: true, handoverPending: env.handoverPending };
  },
  plan(observed, run) {
    if (!observed.managed) return [];
    const actions: KeycloakDeployAction[] = planDeploy("keycloak-deploy", SERVICE, observed, run);
    // Keycloak reads its env file only at start, so a changed database password recreates it.
    const envChanged = actions.some((action) => action.kind === "file" && action.file.path === KEYCLOAK_ENV_FILE);
    const envExisted = observed.files.some(
      (file) => "spec" in file && file.spec.path === KEYCLOAK_ENV_FILE && file.observed !== undefined,
    );
    if (envChanged && envExisted && !actions.some((action) => action.kind === "service")) {
      const summary = `recreate ${SERVICE} with its changed env file`;
      actions.push({ kind: "service", service: SERVICE, recreate: true, summary });
    }
    if (observed.handoverPending) {
      actions.push({
        kind: "handover",
        summary:
          `hand Keycloak access over from the bootstrap client ${BOOTSTRAP_CLIENT_ID} to ${INSTALLER_CLIENT_ID} ` +
          `in realm ${run.context.desired.realm}`,
      });
    }
    return actions;
  },
  async apply(actions, { context }) {
    const deploy: DeployAction[] = [];
    let handover = false;
    for (const action of actions) {
      if (action.kind === "handover") handover = true;
      else deploy.push(action);
    }
    await applyDeploy(deploy, context);
    if (handover) await runHandover(handoverTarget(context));
    else await requireInstallerAccess(handoverTarget(context));
  },
};
