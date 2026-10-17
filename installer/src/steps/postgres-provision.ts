// Step 8 of the Docker graph: provisions the installation's PostgreSQL with the roles, databases, schema and role
// settings of Platform's PostgreSQL bootstrap, then requires every row of the privilege matrix and a LISTEN/NOTIFY
// round trip as libredb_studio. A converged server whose roles log in with their stored passwords plans nothing, so an
// unchanged re-run executes no statement. The managed server is provisioned as its superuser and an external one as its
// admin role, which the step skips with a note when its inputs are unchanged and no admin password is supplied. With
// postgres.external.provisioning manual a DBA provisions the server, and the step only checks it as the app roles.
import { randomBytes } from "node:crypto";
import { observePath } from "../adapters/host-fs";
import { DockerPsqlRunner } from "../adapters/psql-docker";
import { CA_BUNDLE_FILE, ENV_DIR } from "../docker/layout";
import { composeNetworks } from "../docker/project";
import { POSTGRES_SUPERUSER_SECRET } from "../docker/secrets";
import type { Action, Step } from "../engine/step";
import type { Redactor } from "../log/redact";
import { MANAGED_POSTGRES_PORT } from "../model/desired";
import { checkNotifyRoundTrip, notifyRoundTripScript, PostgresCheckError, serverCheckFailures, V1_REPLICAS } from "../sql/checks";
import {
  appRoleExpectation,
  evaluateMatrix,
  falseRows,
  matrixExpectation,
  observePostgres,
  requireMatrix,
  type MatrixRow,
  type PostgresFacts,
} from "../sql/matrix";
import {
  APP_ROLES,
  backupWarning,
  existingObjects,
  expectedRoles,
  ManualProvisionError,
  ownershipRecords,
  planProvision,
  renderProvisionScript,
  ROLE_SETTINGS,
  ROLE_SPECS,
  roleSecretNames,
  roleVerifiers,
  type AppRole,
  type ProvisionAction,
  type ProvisionScope,
} from "../sql/provision";
import { runScript, type PsqlLogin, type SqlRunner } from "../sql/runner";
import type { InstallerState } from "../state/store";
import { POSTGRES_DOCKER_SERVICE } from "../tls/plan";
import { projectContainers, renderedCompose } from "./deploy";
import { recordedInputHash, recordOwnership, type DockerContext } from "./docker-context";
import { adminLoginOrSkip, externalPostgresOf, requireAdminAccess } from "./preflight-external";

/** The superuser of the managed server and the database it logs in to. */
const MANAGED_ADMIN = { user: "postgres", database: "postgres" } as const;

/** The server to provision and how the installer reaches it. */
export interface ProvisionTarget {
  runner: SqlRunner;
  /** The admin role: the superuser of a managed server, or a role with CREATEROLE and CREATEDB. */
  admin: PsqlLogin;
  /** The host and port the apps use, which the password checks and the LISTEN/NOTIFY round trip use too. */
  server: { host: string; port: number };
  /** The stored password of every role the installation creates. */
  passwords: Readonly<Partial<Record<AppRole, string>>>;
  managedKeycloak: boolean;
  /** Receives every SCRAM verifier, so no output of psql can carry one. */
  redactor: Redactor;
}

export interface ProvisionObservation {
  facts: PostgresFacts;
  scope: ProvisionScope;
  rows: MatrixRow[];
  /** For each role of the installation that exists, whether it logged in with its stored password. */
  logins: Partial<Record<AppRole, boolean>>;
}

function roleLogin(target: Pick<ProvisionTarget, "server" | "passwords">, role: AppRole): PsqlLogin {
  const spec = ROLE_SPECS[role];
  const password = target.passwords[role];
  if (password === undefined) throw new Error(`no stored password for role ${spec.name}`);
  return { ...target.server, database: spec.database, user: spec.name, password };
}

/** Reads the server as the admin role, and tries the stored password of every role of the installation that exists. */
export async function observeProvision(target: ProvisionTarget): Promise<ProvisionObservation> {
  const facts = await observePostgres(target.runner, target.admin);
  const scope = matrixExpectation(facts.admin, target.managedKeycloak);
  const existing = new Set(facts.roles.map((role) => role.name));
  const logins = await Promise.all(
    expectedRoles(scope)
      .filter((role) => existing.has(ROLE_SPECS[role].name))
      .map(async (role) => [role, (await target.runner.run(roleLogin(target, role), "SELECT 1;\n")).exitCode === 0] as const),
  );
  return { facts, scope, rows: evaluateMatrix(facts, scope), logins: Object.fromEntries(logins) };
}

export function planProvisionRun(
  observed: ProvisionObservation,
  target: Pick<ProvisionTarget, "managedKeycloak">,
  state: InstallerState,
): ProvisionAction[] {
  return planProvision({
    facts: observed.facts,
    rows: observed.rows,
    logins: observed.logins,
    ownership: state.ownership,
    expectation: observed.scope,
    budget: { managedKeycloak: target.managedKeycloak, ...V1_REPLICAS },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the provisioning script, records every object of the installation that exists afterwards (also when the
 * script failed halfway, so the next run never takes them for someone else's), then requires the privilege matrix
 * (exit 4) and a LISTEN/NOTIFY round trip as libredb_studio (exit 3).
 */
export async function applyProvision(
  actions: readonly ProvisionAction[],
  target: ProvisionTarget,
  state: InstallerState,
  warn: (message: string) => void,
): Promise<void> {
  const verifiers = roleVerifiers(target.passwords);
  for (const verifier of Object.values(verifiers)) target.redactor.register(verifier);
  const resetPasswords = actions.flatMap((action) => (action.kind === "password" ? [action.role] : []));
  const script = renderProvisionScript({ verifiers, managedKeycloak: target.managedKeycloak, resetPasswords });
  let scriptError: unknown;
  try {
    await runScript(target.runner, target.admin, script);
  } catch (error) {
    scriptError = error;
  }
  let facts: PostgresFacts;
  try {
    facts = await observePostgres(target.runner, target.admin);
  } catch (error) {
    if (scriptError === undefined) throw error;
    throw new AggregateError(
      [scriptError, error],
      `${messageOf(scriptError)}; reading the server afterwards to record what exists failed too: ${messageOf(error)}`,
    );
  }
  const scope = matrixExpectation(facts.admin, target.managedKeycloak);
  for (const record of ownershipRecords(existingObjects(facts, scope))) recordOwnership(state, record);
  if (scriptError !== undefined) throw scriptError;
  requireMatrix(evaluateMatrix(facts, scope));
  const warning = backupWarning(facts.admin);
  if (warning !== undefined) warn(warning);
  const nonce = randomBytes(16).toString("hex");
  const studio = roleLogin(target, "studio");
  checkNotifyRoundTrip(await target.runner.run(studio, notifyRoundTripScript(nonce)), nonce, studio);
}

/** What the checks of provisioning manual reach the server with: the app roles and their stored passwords. */
export type ManualTarget = Pick<ProvisionTarget, "runner" | "server" | "passwords" | "managedKeycloak">;

/**
 * The checks of an external server that a DBA provisioned with the script of db-script, run as the app roles because
 * the installer holds no admin credential: every role logs in with its stored password, the server checks, the
 * privilege matrix as libredb_platform reads it, and a LISTEN/NOTIFY round trip as libredb_studio. Returns one line
 * per problem.
 */
export async function manualProvisionProblems(target: ManualTarget): Promise<string[]> {
  const roles = expectedRoles({ managedKeycloak: target.managedKeycloak, backupRole: false });
  const logins = await Promise.all(
    roles.map(async (role) => ({ role, ok: (await target.runner.run(roleLogin(target, role), "SELECT 1;\n")).exitCode === 0 })),
  );
  const problems = logins
    .filter((login) => !login.ok)
    .map((login) => `${ROLE_SPECS[login.role].name} does not log in with the password the installer stored`);
  if (problems.length > 0) return problems;
  const facts = await observePostgres(target.runner, roleLogin(target, "platform"));
  problems.push(...serverCheckFailures(facts.server, { managedKeycloak: target.managedKeycloak, ...V1_REPLICAS }));
  problems.push(...falseRows(evaluateMatrix(facts, appRoleExpectation(facts, target.managedKeycloak))));
  if (problems.length > 0) return problems;
  const nonce = randomBytes(16).toString("hex");
  const studio = roleLogin(target, "studio");
  try {
    checkNotifyRoundTrip(await target.runner.run(studio, notifyRoundTripScript(nonce)), nonce, studio);
  } catch (error) {
    if (!(error instanceof PostgresCheckError)) throw error;
    problems.push(...error.failures);
  }
  return problems;
}

type DockerObservation = ProvisionObservation | { pending: string } | { note: string } | { manualProblems: string[] };

type DockerProvisionAction = ProvisionAction | (Action & { kind: "pending"; reason: string });

const managedKeycloak = (context: DockerContext) => context.config.keycloak.mode === "managed";

function dataNetwork(context: DockerContext): string {
  const network = composeNetworks(renderedCompose(context.desired)).find((candidate) => candidate.key === "data");
  if (network === undefined) throw new Error("the rendered compose file has no network data");
  return network.name;
}

/**
 * psql in one-shot containers of the pinned PostgreSQL image on the data network, trusting the CA bundle. The data
 * network reaches the managed server, or an external one, for which it is not internal.
 */
export function postgresRunner(context: DockerContext): DockerPsqlRunner {
  return new DockerPsqlRunner({
    image: context.desired.images.postgres,
    network: dataNetwork(context),
    caBundleFile: CA_BUNDLE_FILE,
    envDir: ENV_DIR,
    redactor: context.redactor,
    log: context.log,
  });
}

/** The superuser of the managed server, which provisioning and the verify checks log in as. */
export function managedAdminLogin(password: string): PsqlLogin {
  return { host: POSTGRES_DOCKER_SERVICE, port: MANAGED_POSTGRES_PORT, ...MANAGED_ADMIN, password };
}

const pending = (reason: string) => ({ pending: reason });

/**
 * What provisioning reaches either server with, or why it cannot yet: the runner, the server the apps use and the
 * stored password of every role of the installation.
 */
async function serverTarget(context: DockerContext, extraSecrets: readonly string[]): Promise<ManualTarget | { pending: string }> {
  const roles = APP_ROLES.filter((role) => role !== "keycloak" || managedKeycloak(context));
  const names = [...extraSecrets, ...roleSecretNames(managedKeycloak(context))];
  const stored = (await context.secrets.fingerprints()).values;
  const missing = names.filter((name) => stored[name] === undefined);
  if (missing.length > 0) return pending(`secrets ${missing.join(", ")} are not generated yet, so apply the secrets step first`);
  if (observePath(CA_BUNDLE_FILE) === undefined) return pending(`${CA_BUNDLE_FILE} does not exist yet, so apply the base step first`);
  const secrets = await context.secrets.get(names.filter((name) => name !== POSTGRES_SUPERUSER_SECRET));
  const { host, port } = context.desired.postgres;
  return {
    runner: postgresRunner(context),
    server: { host, port },
    passwords: Object.fromEntries(roles.map((role) => [role, secrets[ROLE_SPECS[role].secret]])),
    managedKeycloak: managedKeycloak(context),
  };
}

/** The managed server as a provisioning target, or why it cannot be reached yet. */
async function managedTarget(context: DockerContext): Promise<ProvisionTarget | { pending: string }> {
  const target = await serverTarget(context, [POSTGRES_SUPERUSER_SECRET]);
  if ("pending" in target) return target;
  const container = (await projectContainers(context)).find((entry) => entry.service === POSTGRES_DOCKER_SERVICE);
  if (container?.state !== "running" || container.health !== "healthy") {
    return pending("the managed PostgreSQL is not running and healthy yet, so apply the postgres-deploy step first");
  }
  const { [POSTGRES_SUPERUSER_SECRET]: password } = await context.secrets.get([POSTGRES_SUPERUSER_SECRET]);
  return { ...target, admin: managedAdminLogin(password as string), redactor: context.redactor };
}

const ADMIN_USE = { needs: "postgres-provision", skipped: "postgres-provision was skipped" };

const SUMMARY =
  "provision the PostgreSQL server with the roles, databases and settings of Platform's PostgreSQL bootstrap";

export const postgresProvisionStep: Step<DockerContext, DockerObservation, DockerProvisionAction> = {
  name: "postgres-provision",
  inputs(context) {
    const inputs = {
      image: context.desired.images.postgres,
      managedKeycloak: managedKeycloak(context),
      roles: ROLE_SPECS,
      settings: ROLE_SETTINGS,
    };
    if (context.desired.postgres.managed) return inputs;
    const { host, port, provisioning, adminUser } = externalPostgresOf(context.config);
    return { ...inputs, external: { host, port, provisioning, ...(adminUser === undefined ? {} : { adminUser }) } };
  },
  async observe({ context, state, inputHash }) {
    if (context.desired.postgres.managed) {
      const target = await managedTarget(context);
      return "pending" in target ? target : observeProvision(target);
    }
    const target = await serverTarget(context, []);
    if ("pending" in target) return target;
    if (externalPostgresOf(context.config).provisioning === "manual") {
      return { manualProblems: await manualProvisionProblems(target) };
    }
    const unchanged = recordedInputHash(state, "postgres-provision") === inputHash;
    const admin = await adminLoginOrSkip(requireAdminAccess(context), ADMIN_USE, unchanged);
    if ("note" in admin) return admin;
    return observeProvision({ ...target, admin: admin.login, redactor: context.redactor });
  },
  plan(observed, { context, state }) {
    if ("pending" in observed) return [{ kind: "pending", reason: observed.pending, summary: SUMMARY }];
    if ("note" in observed) {
      context.warn(observed.note);
      return [];
    }
    if ("manualProblems" in observed) {
      if (observed.manualProblems.length > 0) throw new ManualProvisionError(context.desired.postgres, observed.manualProblems);
      return [];
    }
    return planProvisionRun(observed, { managedKeycloak: managedKeycloak(context) }, state);
  },
  async apply(actions, { context, state }) {
    const provisionActions: ProvisionAction[] = [];
    for (const action of actions) {
      if (action.kind === "pending") throw new Error(`cannot ${action.summary}: ${action.reason}`);
      provisionActions.push(action);
    }
    let target: ProvisionTarget | { pending: string };
    if (context.desired.postgres.managed) {
      target = await managedTarget(context);
    } else {
      const server = await serverTarget(context, []);
      target =
        "pending" in server
          ? server
          : { ...server, admin: await requireAdminAccess(context).require(ADMIN_USE.needs), redactor: context.redactor };
    }
    if ("pending" in target) throw new Error(`cannot ${SUMMARY}: ${target.pending}`);
    await applyProvision(provisionActions, target, state, context.warn);
  },
};
