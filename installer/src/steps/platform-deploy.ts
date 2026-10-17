// Step 12 of the Docker graph: Platform's web server on networks edge and data, with its runtime env of
// contracts/env-inventory.yaml in its own 0600 env file. It runs after platform-migrate, so a migrate that failed never
// reaches it and the running Platform stays as it was. A changed service definition, env file or CA bundle recreates
// the container, because Platform reads them at start.
import { readOptionalFile } from "../adapters/host-fs";
import { CA_BUNDLE_FILE } from "../docker/layout";
import { serviceDefinition } from "../docker/project";
import { APP_SECRET_NAMES, platformSealKey } from "../docker/secrets";
import type { Step } from "../engine/step";
import { CLIENT_SECRET_NAMES } from "../keycloak/desired";
import type { PostgresServer } from "../model/database-urls";
import { readAuthSecretPrevious, readPlatformLicense, renderPlatformEnv } from "../model/platform-env";
import { PLATFORM_ENV_FILE, PLATFORM_SERVICE, renderComposeEnvFile } from "../render/compose";
import { ROLE_SPECS } from "../sql/provision";
import type { PsqlLogin } from "../sql/runner";
import { POSTGRES_NAMES } from "../state/immutable";
import { applyDeploy, composeFileSpec, observeDeploy, planDeploy, renderedCompose, type DeployAction, type DeployObservation } from "./deploy";
import { fileFingerprint, type DockerContext } from "./docker-context";

/** Where the apps reach the installation's PostgreSQL: the managed server on network data, or the external one. */
export function postgresServer(context: Pick<DockerContext, "desired">): PostgresServer {
  const { host, port } = context.desired.postgres;
  return { host, port };
}

/** libredb_platform on database libredb, as Platform's runtime and `db-shell --as platform` log in. */
export function platformLogin(server: PostgresServer, password: string): PsqlLogin {
  return { ...server, database: POSTGRES_NAMES.database, user: POSTGRES_NAMES.roles.platform, password };
}

/** Reads the values of the secrets a step asked for. */
export type SecretValues = { value: (name: string) => string };

/** The values of the named secrets, or why they are not there yet. */
export async function storedSecrets(
  context: Pick<DockerContext, "secrets">,
  names: readonly string[],
): Promise<SecretValues | { pending: string }> {
  const stored = (await context.secrets.fingerprints()).values;
  const missing = names.filter((name) => stored[name] === undefined);
  if (missing.length > 0) {
    return { pending: `secrets ${missing.join(", ")} are not generated yet, so apply the secrets step first` };
  }
  const values = await context.secrets.get(names);
  return {
    value(name) {
      const value = values[name];
      if (value === undefined) throw new Error(`the secret store returned no value for ${name}`);
      return value;
    },
  };
}

/** The value of one secret the store must hold. */
export async function secretValue(context: Pick<DockerContext, "secrets">, name: string): Promise<string> {
  const secrets = await storedSecrets(context, [name]);
  if ("pending" in secrets) throw new Error(secrets.pending);
  return secrets.value(name);
}

const RUNTIME_SECRETS = [ROLE_SPECS.platform.secret, CLIENT_SECRET_NAMES.platform, APP_SECRET_NAMES.platformAuthSecret];

/** Platform's runtime env file as it must be, or why it cannot be rendered yet. */
async function runtimeEnvFile(context: DockerContext) {
  // Read before anything can leave the file pending, so a missing or malformed license file stops even a first apply
  // while it plans, before it applies any step.
  const license = readPlatformLicense(context.config.platform, readOptionalFile, context.redactor);
  const secrets = await storedSecrets(context, RUNTIME_SECRETS);
  if ("pending" in secrets) return { path: PLATFORM_ENV_FILE, pending: secrets.pending };
  const sealKeys = await context.secrets.sealKeys();
  if (!sealKeys.some((key) => key.state === "live")) {
    return { path: PLATFORM_ENV_FILE, pending: "no live seal key is issued yet, so apply the secrets step first" };
  }
  const authSecretPrevious = readAuthSecretPrevious(context.config.platform, readOptionalFile);
  if (authSecretPrevious !== undefined) context.redactor.register(authSecretPrevious);
  const env = renderPlatformEnv(context.desired, {
    postgres: postgresServer(context),
    secrets: {
      authSecret: secrets.value(APP_SECRET_NAMES.platformAuthSecret),
      ...(authSecretPrevious === undefined ? {} : { authSecretPrevious }),
      ...(license === undefined ? {} : { license }),
      oidcClientSecret: secrets.value(CLIENT_SECRET_NAMES.platform),
      databasePassword: secrets.value(ROLE_SPECS.platform.secret),
    },
    sealPublicKey: platformSealKey(sealKeys, context.config.bridge.sealKeys.activeKid).publicKey,
  });
  return { path: PLATFORM_ENV_FILE, content: renderComposeEnvFile(env), mode: 0o600, uid: 0, gid: 0 };
}

export const platformDeployStep: Step<DockerContext, DeployObservation, DeployAction> = {
  name: "platform-deploy",
  inputs: (context) => ({
    service: serviceDefinition(renderedCompose(context.desired), PLATFORM_SERVICE),
    caBundle: fileFingerprint(CA_BUNDLE_FILE),
  }),
  observe: async ({ context }) =>
    observeDeploy(context, PLATFORM_SERVICE, [], [composeFileSpec(context), await runtimeEnvFile(context)]),
  plan(observed, run) {
    const actions = planDeploy("platform-deploy", PLATFORM_SERVICE, observed, run);
    // Platform reads its env file only at start, so a changed env file recreates it.
    const envChanged = actions.some((action) => action.kind === "file" && action.file.path === PLATFORM_ENV_FILE);
    const envExisted = observed.files.some(
      (file) => "spec" in file && file.spec.path === PLATFORM_ENV_FILE && file.observed !== undefined,
    );
    if (envChanged && envExisted && !actions.some((action) => action.kind === "service")) {
      const summary = `recreate ${PLATFORM_SERVICE} with its changed env file`;
      actions.push({ kind: "service", service: PLATFORM_SERVICE, recreate: true, summary });
    }
    return actions;
  },
  apply: (actions, { context }) => applyDeploy(actions, context),
};
