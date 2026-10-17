// The preflight of the external components: what the preflight step observes of a customer's own server before the
// graph changes anything, checked by the pure modules of src/preflight. The preflight step of
// src/steps/preflight-docker.ts calls the functions of an external Keycloak, and preflightStep below wraps that step
// with the checks of an external PostgreSQL server. With postgres.external.provisioning installer those run as the
// admin role: PostgreSQL 15 or newer, the primary rather than a standby, SUPERUSER or CREATEROLE and CREATEDB, the
// connection budget of docs/deploy/platform-runtime.md, TLS with sslmode=verify-full against caBundleFile, and a clock
// within 15 s of the installer's. With provisioning manual a DBA provisions the server, and they run as
// libredb_platform, without the attribute check. The admin password is read on each run that needs it and never
// persisted, and the admin access below is shared with postgres-provision.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeRefusal, KeycloakAdmin, requestToken, type AdminCredentials } from "../adapters/keycloak-admin";
import { DockerPsqlRunner } from "../adapters/psql-docker";
import { ExitCode } from "../cli/exit-codes";
import type { ExternalPostgres, LibreDBInstallation } from "../config/schema";
import { readSecretReference, type SecretSources } from "../config/secret-ref";
import { composeNetworks } from "../docker/project";
import type { Step, StepRun } from "../engine/step";
import { APP_CLIENT_IDS } from "../keycloak/desired";
import type { Redactor } from "../log/redact";
import { PreflightError } from "../preflight/docker-checks";
import {
  checkExternalKeycloak,
  keycloakExpectations,
  type AdminFindings,
  type ExternalKeycloakObservation,
} from "../preflight/external-keycloak";
import { adminCheckFailures, PostgresCheckError, serverCheckFailures, V1_REPLICAS, type ConnectionBudget } from "../sql/checks";
import { observePostgres, type PostgresFacts } from "../sql/matrix";
import { ROLE_SPECS } from "../sql/provision";
import { SqlError, type PsqlLogin, type SqlRunner } from "../sql/runner";
import { POSTGRES_NAMES } from "../state/immutable";
import type { InstallerState } from "../state/store";
import { certificateToPem, parseCertificates, TlsError } from "../tls/inspect";
import { postgresClockSkew } from "../verify/host";
import { renderedCompose } from "./deploy";
import { fileFingerprint, recordedInputHash, type DockerContext } from "./docker-context";
import { externalAdminAccess, externalKeycloakFetch, findClient } from "./keycloak-configure";
import { preflightDockerStep, type PreflightObservation as DockerPreflightObservation } from "./preflight-docker";

const TIMEOUT_MS = 30_000;

const segment = encodeURIComponent;

/** How preflight reaches an external Keycloak and what it reads there. */
export interface ExternalKeycloakProbe {
  /** The issuer both apps trust, `<keycloak.external.baseUrl>/realms/<realm>`. */
  issuer: string;
  realm: string;
  /** Where the installer reaches the Admin API. */
  adminUrl: string;
  caBundleFile: string | undefined;
  /**
   * The customer's admin credential, the note of a run that skips the checks that need it, or `manual` when the site
   * configures the realm and the installer holds no admin credential.
   */
  access: { credentials: AdminCredentials } | { skipped: string } | { manual: true };
  /** A fetch that trusts the system roots and keycloak.external.caBundleFile. */
  fetch: typeof fetch;
  /** Receives one line per Keycloak request, never a token or a secret. */
  log: (line: string) => void;
  /** The installer clock in epoch milliseconds. */
  now?: () => number;
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
}

async function readDiscovery(probe: ExternalKeycloakProbe): Promise<ExternalKeycloakObservation["discovery"]> {
  const url = `${probe.issuer}/.well-known/openid-configuration`;
  try {
    const response = await probe.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    probe.log(`keycloak GET ${new URL(url).pathname} ${response.status}`);
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, issuer: undefined };
    }
    const document = (await response.json()) as { issuer?: unknown };
    return { status: 200, issuer: typeof document.issuer === "string" ? document.issuer : undefined };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** The `iat` of a token in epoch milliseconds, which is Keycloak's clock because Keycloak 26 sends no Date header. */
function issuedAt(token: string): number {
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { iat?: unknown };
  if (typeof payload.iat !== "number") throw new Error("the Keycloak token holds no iat");
  return payload.iat * 1000;
}

async function readAdmin(probe: ExternalKeycloakProbe, credentials: AdminCredentials): Promise<AdminFindings | { error: string }> {
  const now = probe.now ?? Date.now;
  try {
    const before = now();
    const answer = await requestToken({ baseUrl: probe.adminUrl, log: probe.log, fetch: probe.fetch }, credentials);
    const installerMs = (before + now()) / 2;
    if ("status" in answer) return { error: `${describeRefusal(credentials)} with ${answer.status}` };
    const clock = { keycloakMs: issuedAt(answer.token), installerMs };
    const admin = new KeycloakAdmin({ baseUrl: probe.adminUrl, credentials, log: probe.log, fetch: probe.fetch });
    const info = await admin.get<{ systemInfo?: { version?: unknown } }>("/admin/serverinfo");
    const version = info.systemInfo?.version;
    if (typeof version !== "string") throw new Error("GET /admin/serverinfo names no systemInfo.version");
    const realm = await admin.find<{ ssoSessionIdleTimeout?: unknown }>(`/admin/realms/${segment(probe.realm)}`);
    if (realm === undefined) return { clock, version, realm: null, appClients: [] };
    if (typeof realm.ssoSessionIdleTimeout !== "number") throw new Error(`realm ${probe.realm} names no ssoSessionIdleTimeout`);
    const appClients: AdminFindings["appClients"] = [];
    for (const clientId of [APP_CLIENT_IDS.studio, APP_CLIENT_IDS.platform]) {
      const client = await findClient(admin, probe.realm, clientId);
      if (client !== undefined) appClients.push({ clientId, mappers: client.protocolMappers ?? [] });
    }
    return { clock, version, realm: { ssoSessionIdleTimeout: realm.ssoSessionIdleTimeout }, appClients };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/**
 * Reads what the preflight of an external Keycloak checks, with token and GET requests only: the realm's discovery
 * document over TLS, and with the admin credential the Keycloak version, the realm with its SSO Session Idle, the
 * protocol mappers of the app clients and Keycloak's clock.
 */
export async function observeExternalKeycloakAt(probe: ExternalKeycloakProbe): Promise<ExternalKeycloakObservation> {
  const discovery = await readDiscovery(probe);
  const admin = "credentials" in probe.access ? await readAdmin(probe, probe.access.credentials) : probe.access;
  return { issuer: probe.issuer, realm: probe.realm, adminUrl: probe.adminUrl, caBundleFile: probe.caBundleFile, discovery, admin };
}

/** Observes the external Keycloak of the configuration, or returns undefined for a managed one. */
export async function observeExternalKeycloak(
  context: DockerContext,
  state: InstallerState,
): Promise<ExternalKeycloakObservation | undefined> {
  const { keycloak } = context.config;
  if (keycloak.mode !== "external") return undefined;
  const { external } = keycloak;
  return observeExternalKeycloakAt({
    issuer: context.desired.issuer,
    realm: context.desired.realm,
    adminUrl: context.desired.keycloak.adminUrl,
    caBundleFile: external.caBundleFile,
    access:
      external.provisioning === "manual"
        ? { manual: true }
        : externalAdminAccess(context, state, external, "the preflight of the external Keycloak"),
    fetch: externalKeycloakFetch(external),
    log: context.info,
  });
}

/** Checks the observed external Keycloak, records its warnings, and throws PreflightError naming every problem. */
export function checkExternalKeycloakFindings(observed: ExternalKeycloakObservation | undefined, context: DockerContext): void {
  if (observed === undefined) return;
  for (const warning of checkExternalKeycloak(observed, keycloakExpectations(context.manifest))) context.warn(warning);
}

/** The external PostgreSQL server of a configuration; only an installation with postgres.mode external has one. */
export function externalPostgresOf(config: LibreDBInstallation): ExternalPostgres {
  if (config.postgres.mode !== "external") throw new Error("the configuration has no external PostgreSQL server");
  return config.postgres.external;
}

/** The connection budget of an external server, which holds Keycloak's database only for a managed Keycloak. */
export function externalBudget(config: LibreDBInstallation): ConnectionBudget {
  return { managedKeycloak: config.keycloak.mode === "managed", ...V1_REPLICAS };
}

/** The database the admin role logs in to, which every PostgreSQL server has. */
const ADMIN_DATABASE = "postgres";

/** How a run reaches the admin role of an external server with provisioning installer. */
export interface PostgresAdminOptions {
  external: ExternalPostgres;
  redactor: Redactor;
  sources: SecretSources;
  /** Whether stdin is a terminal the operator can answer a prompt on. */
  isTTY: () => boolean;
  /** Asks for a secret on the terminal with masked entry. */
  prompt: (question: string) => Promise<string>;
}

/** A step needs the admin password, no terminal can ask for it, and the configuration supplies none. */
export class AdminPasswordMissingError extends Error {
  readonly exitCode = ExitCode.InvalidUsage;

  constructor(message: string) {
    super(message);
    this.name = "AdminPasswordMissingError";
  }
}

/**
 * The admin role of an external PostgreSQL server for one run. The password comes from postgres.external.
 * adminPasswordEnv or adminPasswordFile, or from a masked prompt on a terminal; it is read once per run, registered
 * with the redactor and kept in memory only, never in the state, an env file or the secret store.
 */
export class PostgresAdminAccess {
  readonly #options: PostgresAdminOptions;
  #password: string | undefined;

  constructor(options: PostgresAdminOptions) {
    if (options.external.provisioning !== "installer" || options.external.adminUser === undefined) {
      throw new Error("only provisioning installer reaches the admin role of an external PostgreSQL server");
    }
    this.#options = options;
  }

  /** The admin role and the server, as notes and prompts name them, such as `corp_dba of ... pg.corp:5432`. */
  describe(): string {
    const { adminUser, host, port } = this.#options.external;
    return `the admin role ${adminUser} of the external PostgreSQL server ${host}:${port}`;
  }

  #login(password: string): PsqlLogin {
    const { host, port, adminUser } = this.#options.external;
    return { host, port, database: ADMIN_DATABASE, user: adminUser as string, password };
  }

  #remember(password: string): PsqlLogin {
    this.#options.redactor.register(password);
    this.#password = password;
    return this.#login(password);
  }

  #lookup() {
    const { adminPasswordEnv, adminPasswordFile } = this.#options.external;
    return readSecretReference(
      { path: "postgres.external.adminPassword", env: adminPasswordEnv, file: adminPasswordFile },
      this.#options.sources,
    );
  }

  /** The login when this run has the password, asked earlier or supplied through the configured reference. */
  supplied(): PsqlLogin | undefined {
    if (this.#password !== undefined) return this.#login(this.#password);
    const lookup = this.#lookup();
    return "value" in lookup ? this.#remember(lookup.value) : undefined;
  }

  /** Why the configuration supplies no password in this run. */
  missing(): string {
    const lookup = this.#lookup();
    return "missing" in lookup ? lookup.missing : "it is supplied";
  }

  /**
   * The login for a step that needs the admin role: the supplied password, or else one asked for with masked entry on
   * a terminal. Without a terminal it throws AdminPasswordMissingError, exit 2, naming how to supply the password.
   */
  async require(why: string): Promise<PsqlLogin> {
    const supplied = this.supplied();
    if (supplied !== undefined) return supplied;
    if (!this.#options.isTTY()) {
      throw new AdminPasswordMissingError(
        `${why} needs the password of ${this.describe()}, and ${this.missing()}; set it, or run on a terminal to be ` +
          "asked for it",
      );
    }
    const password = await this.#options.prompt(`Password of ${this.describe()}: `);
    if (password === "") throw new AdminPasswordMissingError(`no password of ${this.describe()} was entered`);
    return this.#remember(password);
  }
}

/** The admin access of a context whose external server is provisioned by the installer. */
export function requireAdminAccess(context: DockerContext): PostgresAdminAccess {
  if (context.postgresAdmin === undefined) {
    throw new Error("this run has no access to the admin role of an external PostgreSQL server");
  }
  return context.postgresAdmin;
}

/** Who needs the admin role, in the words of errors and notes. */
export interface AdminUse {
  /** The subject of an error, such as "postgres-provision". */
  needs: string;
  /** The subject of the note of a skip, such as "postgres-provision was skipped". */
  skipped: string;
}

/**
 * The admin login of a step, or a note when the step skips: its inputs are unchanged since it last succeeded and no
 * password is supplied, so an unattended run such as the certificate renewal timer keeps working.
 */
export async function adminLoginOrSkip(
  access: PostgresAdminAccess,
  use: AdminUse,
  unchanged: boolean,
): Promise<{ login: PsqlLogin } | { note: string }> {
  const login = access.supplied();
  if (login !== undefined) return { login };
  if (unchanged) {
    return {
      note:
        `${use.skipped}, because its inputs are unchanged since it last succeeded and no password of ` +
        `${access.describe()} is supplied: ${access.missing()}`,
    };
  }
  return { login: await access.require(use.needs) };
}

/**
 * What preflight verifies an external server's certificate against: the first certificate of
 * postgres.external.caBundleFile. The CA bundle leads with it, and Prisma in Platform's migrate job trusts that one
 * only, while every other client trusts the whole bundle, so a server that passes preflight passes every client.
 * Without that file, or with one that holds no certificate, it is the problem to name.
 */
export function preflightTrust(external: ExternalPostgres, readFile: (path: string) => string): { pem: string } | { problem: string } {
  const where = `the external PostgreSQL server ${external.host}:${external.port}`;
  const file = external.caBundleFile;
  if (file === undefined) {
    return {
      problem:
        `postgres.external.caBundleFile is not set, so the certificate of ${where} cannot be verified with ` +
        "sslmode=verify-full: set it to the CA that issued that certificate",
    };
  }
  let pem: string;
  try {
    pem = readFile(file);
  } catch (error) {
    return { problem: `cannot read postgres.external.caBundleFile ${file}: ${messageOf(error)}` };
  }
  try {
    const [first] = parseCertificates(pem, file);
    return { pem: certificateToPem(first) };
  } catch (error) {
    if (error instanceof TlsError) return { problem: `postgres.external.caBundleFile ${error.message}` };
    throw error;
  }
}

/** Where preflight reaches an external PostgreSQL server, and as which role. */
export interface ExternalPostgresTarget {
  runner: SqlRunner;
  /** The admin role with provisioning installer, or libredb_platform with provisioning manual. */
  login: PsqlLogin;
  provisioning: ExternalPostgres["provisioning"];
  budget: ConnectionBudget;
  /** The installer clock, in epoch milliseconds. */
  now: () => number;
}

/** psql exits 2 when it cannot open the connection, as on a certificate that does not verify. */
const PSQL_CONNECTION_FAILED = 2;

function connectionProblem(target: ExternalPostgresTarget, stderr: string): string {
  const { login } = target;
  const detail = stderr.trim().replace(/^psql: error: /, "");
  const hints: string[] = [];
  if (/certificate|SSL/i.test(detail)) {
    hints.push(
      "the first certificate of postgres.external.caBundleFile must be the CA that issued the server certificate",
    );
  }
  if (target.provisioning === "manual") {
    hints.push("with provisioning manual, a DBA runs the script of 'libredb-installer db-script' first");
  }
  return (
    `cannot connect to the external PostgreSQL server ${login.host}:${login.port} as ${login.user} with ` +
    `sslmode=verify-full: ${[detail, ...hints].join("; ")}`
  );
}

/** Runs the PostgreSQL checks and returns one line per failed check; a connection psql cannot open is one of them. */
export async function externalPostgresProblems(target: ExternalPostgresTarget): Promise<string[]> {
  let facts: PostgresFacts;
  try {
    facts = await observePostgres(target.runner, target.login);
  } catch (error) {
    if (error instanceof PostgresCheckError) return [...error.failures];
    if (error instanceof SqlError && error.result.exitCode === PSQL_CONNECTION_FAILED) {
      return [connectionProblem(target, error.result.stderr)];
    }
    throw error;
  }
  const problems = serverCheckFailures(facts.server, target.budget);
  if (target.provisioning === "installer") problems.push(...adminCheckFailures(facts.admin));
  const skew = await postgresClockSkew({ now: target.now, sql: target.runner, login: target.login });
  if (skew !== undefined) problems.push(skew);
  return problems;
}

/** Throws PreflightError, exit 3, naming every failed PostgreSQL check. */
export async function checkExternalPostgres(target: ExternalPostgresTarget): Promise<void> {
  const problems = await externalPostgresProblems(target);
  if (problems.length > 0) throw new PreflightError(problems);
}

/**
 * The network the psql containers of preflight join: the data network once base created it, which reaches the server
 * the way the apps do, and before that Docker's default bridge.
 */
async function preflightNetwork(context: DockerContext): Promise<string> {
  const data = composeNetworks(renderedCompose(context.desired)).find((network) => network.key === "data");
  if (data !== undefined && (await context.docker.networkInspect(data.name)) !== undefined) return data.name;
  return "bridge";
}

/** The login of preflight with provisioning manual, libredb_platform with its stored password, or why there is none. */
async function manualLogin(context: DockerContext, external: ExternalPostgres): Promise<PsqlLogin | { problem: string }> {
  const secret = ROLE_SPECS.platform.secret;
  if ((await context.secrets.fingerprints()).values[secret] === undefined) {
    return {
      problem:
        `the installer has not stored a password for ${POSTGRES_NAMES.roles.platform} yet: run 'libredb-installer ` +
        `db-script -c <libredb.yaml> -o <file>', have a DBA run that script on ${external.host}:${external.port}, then ` +
        "apply again",
    };
  }
  const password = (await context.secrets.get([secret]))[secret] as string;
  return { host: external.host, port: external.port, database: POSTGRES_NAMES.database, user: POSTGRES_NAMES.roles.platform, password };
}

/**
 * Runs the PostgreSQL checks of preflight against the external server: psql in a one-shot container of the pinned
 * image, trusting the first certificate of postgres.external.caBundleFile from a temporary directory.
 */
async function observeExternalPostgres(run: StepRun<DockerContext>): Promise<{ problems: string[] } | { note: string }> {
  const { context } = run;
  const external = externalPostgresOf(context.config);
  // First, so a missing caBundleFile is named before anyone is asked for a password.
  const trust = preflightTrust(external, (path) => readFileSync(path, "utf8"));
  if ("problem" in trust) return { problems: [trust.problem] };
  let login: PsqlLogin;
  if (external.provisioning === "manual") {
    const manual = await manualLogin(context, external);
    if ("problem" in manual) return { problems: [manual.problem] };
    login = manual;
  } else {
    const unchanged = recordedInputHash(run.state, "preflight") === run.inputHash;
    const use = { needs: "preflight", skipped: "the PostgreSQL checks of preflight were skipped" };
    const admin = await adminLoginOrSkip(requireAdminAccess(context), use, unchanged);
    if ("note" in admin) return admin;
    login = admin.login;
  }
  const image = context.desired.images.postgres;
  // psql runs in a container of the pinned image, which the images step pulls only after preflight.
  if ((await context.docker.imageInspect(image)) === undefined) await context.docker.pull(image);
  const scratch = mkdtempSync(join(tmpdir(), "libredb-preflight-"));
  try {
    const caBundleFile = join(scratch, "ca.crt");
    writeFileSync(caBundleFile, trust.pem, { mode: 0o644 });
    const envDir = join(scratch, "env");
    mkdirSync(envDir, { mode: 0o700 });
    const runner = new DockerPsqlRunner({
      image,
      network: await preflightNetwork(context),
      caBundleFile,
      envDir,
      redactor: context.redactor,
      log: context.log,
      namePrefix: "libredb-preflight-psql",
    });
    const budget = externalBudget(context.config);
    const target = { runner, login, provisioning: external.provisioning, budget, now: () => Date.now() };
    return { problems: await externalPostgresProblems(target) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What the PostgreSQL checks of preflight converge on: the server, the role they log in as and the CA they trust. */
function externalPostgresInputs(config: LibreDBInstallation) {
  const { host, port, provisioning, adminUser, caBundleFile } = externalPostgresOf(config);
  return {
    host,
    port,
    provisioning,
    ...(adminUser === undefined ? {} : { adminUser }),
    caBundleFile: caBundleFile === undefined ? null : { path: caBundleFile, sha256: fileFingerprint(caBundleFile) },
  };
}

export interface PreflightObservation {
  host: DockerPreflightObservation;
  /** The problems of the external PostgreSQL checks, or the note of skipped checks; absent with a managed server. */
  postgres?: { problems: string[] } | { note: string };
}

/**
 * Step 1 of the Docker graph: the host checks, and with an external PostgreSQL the checks of that server. Every
 * problem is named in one PreflightError, exit 3, and the step never changes the installation, so its plan is empty.
 */
export const preflightStep: Step<DockerContext, PreflightObservation> = {
  name: "preflight",
  inputs(context) {
    const host = preflightDockerStep.inputs(context) as Record<string, unknown>;
    return context.config.postgres.mode === "external" ? { ...host, postgres: externalPostgresInputs(context.config) } : host;
  },
  async observe(run) {
    const host = await preflightDockerStep.observe(run);
    // Without a Docker Engine no psql container can run, and the host checks name that already.
    if (run.context.config.postgres.mode !== "external" || !host.dockerEngine.found) return { host };
    return { host, postgres: await observeExternalPostgres(run) };
  },
  plan(observed, run) {
    const problems: string[] = [];
    try {
      preflightDockerStep.plan(observed.host, run);
    } catch (error) {
      if (!(error instanceof PreflightError)) throw error;
      problems.push(...error.problems);
    }
    if (observed.postgres !== undefined) {
      if ("note" in observed.postgres) run.context.warn(observed.postgres.note);
      else problems.push(...observed.postgres.problems);
    }
    if (problems.length > 0) throw new PreflightError(problems);
    return [];
  },
  apply() {
    throw new Error("the preflight step plans no action, so there is nothing to apply");
  },
};
