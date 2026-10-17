// Step 7 of the Docker graph: the managed PostgreSQL on the internal network `data`, with TLS from the
// internal CA, a pg_hba.conf that accepts only hostssl with SCRAM, and the superuser password in a 0600 env file.
// A renewed server leaf or a changed pg_hba.conf is loaded with SELECT pg_reload_conf(), so the server keeps running
// and its container keeps its id. An installation with an external PostgreSQL deploys none, so the step
// plans nothing there.
import { POSTGRES_SUPERUSER_SECRET } from "../docker/secrets";
import { POSTGRES_CONFIG_DIRECTORY, leafFiles } from "../docker/layout";
import { serviceDefinition } from "../docker/project";
import { planReloadableService, type ReloadAction } from "../docker/services";
import type { Step } from "../engine/step";
import { PG_HBA_FILE, POSTGRES_ENV_FILE, renderPgHba } from "../render/compose";
import { runScript } from "../sql/runner";
import { desiredTls } from "../tls/plan";
import { fileFingerprint, recordedInputHash, type DockerContext } from "./docker-context";
import { applyDeploy, composeFileSpec, observeDeploy, planDeploy, renderedCompose, type DeployAction, type DeployObservation } from "./deploy";
import { secretValue } from "./platform-deploy";
import { managedAdminLogin, postgresRunner } from "./postgres-provision";

const SERVICE = "postgres";
const RELOAD = "reload the server certificate and pg_hba.conf of postgres with SELECT pg_reload_conf()";

type PostgresDeployAction = DeployAction | ReloadAction;

function postgresLeaf(context: DockerContext) {
  const leaf = desiredTls(context.config).leaves.find((candidate) => candidate.name === "postgres");
  if (leaf === undefined) throw new Error("the TLS plan has no leaf for the managed PostgreSQL server");
  return leaf;
}

async function envFile(context: DockerContext) {
  const stored = (await context.secrets.fingerprints()).values;
  if (stored[POSTGRES_SUPERUSER_SECRET] === undefined) {
    return { path: POSTGRES_ENV_FILE, pending: `secret ${POSTGRES_SUPERUSER_SECRET} is not generated yet, so apply the secrets step first` };
  }
  const { [POSTGRES_SUPERUSER_SECRET]: password } = await context.secrets.get([POSTGRES_SUPERUSER_SECRET]);
  return { path: POSTGRES_ENV_FILE, content: `POSTGRES_PASSWORD=${password}\n`, mode: 0o600, uid: 0, gid: 0 };
}

export type PostgresDeployObservation = { managed: false } | (DeployObservation & { managed: true });

export const postgresDeployStep: Step<DockerContext, PostgresDeployObservation, PostgresDeployAction> = {
  name: "postgres-deploy",
  inputs: (context) =>
    context.desired.postgres.managed
      ? {
          service: serviceDefinition(renderedCompose(context.desired), SERVICE),
          pgHba: renderPgHba(),
          certificate: fileFingerprint(leafFiles(postgresLeaf(context)).certificate),
        }
      : { managed: false },
  async observe({ context }) {
    if (!context.desired.postgres.managed) return { managed: false };
    const observed = await observeDeploy(
      context,
      SERVICE,
      [POSTGRES_CONFIG_DIRECTORY],
      [
        composeFileSpec(context),
        { path: PG_HBA_FILE, content: renderPgHba(), mode: 0o644, uid: 0, gid: 0 },
        await envFile(context),
      ],
    );
    return { ...observed, managed: true };
  },
  plan(observed, run) {
    if (!observed.managed) return [];
    const actions: PostgresDeployAction[] = planDeploy("postgres-deploy", SERVICE, observed, run).filter(
      (action) => action.kind !== "service",
    );
    const service = {
      service: SERVICE,
      container: observed.container,
      recordedInputHash: recordedInputHash(run.state, "postgres-deploy"),
      inputHash: run.inputHash,
    };
    return [...actions, ...planReloadableService(service, RELOAD)];
  },
  async apply(actions, { context }) {
    await applyDeploy(
      actions.filter((action): action is DeployAction => action.kind !== "reload"),
      context,
    );
    if (actions.some((action) => action.kind === "reload")) {
      const admin = managedAdminLogin(await secretValue(context, POSTGRES_SUPERUSER_SECRET));
      await runScript(postgresRunner(context), admin, "SELECT pg_reload_conf();\n");
    }
  },
};
