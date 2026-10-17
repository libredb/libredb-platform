// The check of a realm that the customer's identity team configured from the installer's export
// (`keycloak.external.provisioning: manual`). The installer holds no Keycloak admin credential
// then, only the secrets of libredb-studio and libredb-platform, so it checks from outside what those two clients can
// see: the issuer's discovery document, both secrets through token introspection, a client_credentials token of
// libredb-platform, and with that token what the realm-management roles view-users and view-clients let it read. Every
// finding is collected, so one run names everything the identity team has to fix, and a refusal exits 3.
import { ExitCode } from "../cli/exit-codes";
import { APP_CLIENT_IDS, ROLE_CLIENT_ID, type DesiredClient, type DesiredKeycloak } from "../keycloak/desired";
import { PAIRWISE_CONSEQUENCE, pairwiseFindings } from "../keycloak/planner";
import type { ClientRepresentation } from "../keycloak/representations";

/** An HTTP request the check sent: the status Keycloak answered with and its body, or why there was no answer. */
export type HttpAnswer<T = undefined> = { status: number; body?: T } | { error: string };

/** What the check read from the realm with the two client secrets. */
export interface ManualKeycloakObservation {
  /** The issuer both apps trust, `<keycloak.external.baseUrl>/realms/<realm>`. */
  issuer: string;
  realm: string;
  /** GET <issuer>/.well-known/openid-configuration, with the issuer the document names. */
  discovery: HttpAnswer<{ issuer: string | undefined }>;
  /**
   * Token introspection of an unknown token, authenticated as each app client with its secret: 200 when Keycloak
   * accepts the secret, because it answers an unknown token as inactive, and 401 when it refuses the secret.
   */
  introspection: { clientId: string; answer: HttpAnswer }[];
  /** A client_credentials token request as libredb-platform; status 200 when Keycloak issued a token. */
  token: HttpAnswer;
  /** What the token of libredb-platform read through the Admin API; absent when no token was issued. */
  directory?: {
    /** GET /admin/realms/<realm>/users?max=1, which needs view-users. */
    users: HttpAnswer<unknown>;
    /** GET /admin/realms/<realm>/clients?clientId=<clientId> per client, which needs view-clients. */
    clients: { clientId: string; answer: HttpAnswer<ClientRepresentation[]> }[];
    /** The role names of client libredb, absent when the client could not be read. */
    roles?: HttpAnswer<string[]>;
  };
}

/** What Platform and Studio need of the realm, derived from the same desired objects as the export. */
export interface ManualKeycloakExpectations {
  realm: string;
  issuer: string;
  /** The client roles of the role holder libredb. */
  roles: string[];
  /** libredb-studio and libredb-platform as the export creates them. */
  appClients: DesiredClient[];
  /** The configuration key of each app client's secret reference, without its Env or File suffix. */
  secretKeys: Record<string, string>;
}

/** The expectations of the desired objects, for the realm whose issuer both apps trust. */
export function manualExpectations(desired: DesiredKeycloak, issuer: string): ManualKeycloakExpectations {
  return {
    realm: desired.realm,
    issuer,
    roles: desired.roleClient.roles.map((role) => role.name),
    appClients: desired.appClients,
    secretKeys: {
      [APP_CLIENT_IDS.studio]: "keycloak.external.studioClientSecret",
      [APP_CLIENT_IDS.platform]: "keycloak.external.platformClientSecret",
    },
  };
}

/** A realm configured by the site that differs from the export; exit 3, with one line per finding. */
export class ManualKeycloakError extends Error {
  readonly exitCode = ExitCode.PreflightFailed;
  readonly findings: readonly string[];

  constructor(realm: string, findings: readonly string[]) {
    super(
      [
        `the check of realm ${realm}, which the site configured from the installer's export (keycloak.external.provisioning manual), failed:`,
        ...findings.map((finding) => `  ${finding}`),
      ].join("\n"),
    );
    this.name = "ManualKeycloakError";
    this.findings = findings;
  }
}

const refused = (status: number) => status === 400 || status === 401;

function discoveryFindings(observed: ManualKeycloakObservation): string[] {
  const url = `${observed.issuer}/.well-known/openid-configuration`;
  const { discovery } = observed;
  if ("error" in discovery) return [`GET ${url} failed: ${discovery.error}`];
  if (discovery.status !== 200) return [`GET ${url} answered ${discovery.status}; realm ${observed.realm} must exist there`];
  const named = discovery.body?.issuer;
  if (named === observed.issuer) return [];
  return [
    `${url} names the issuer ${named ?? "(none)"}, and both apps expect ${observed.issuer}; ` +
      "keycloak.external.baseUrl must be the URL that Keycloak announces",
  ];
}

function secretFindings(observed: ManualKeycloakObservation, expected: ManualKeycloakExpectations): string[] {
  return observed.introspection.flatMap(({ clientId, answer }) => {
    if ("error" in answer) return [`token introspection as client ${clientId} failed: ${answer.error}`];
    if (answer.status === 200) return [];
    if (refused(answer.status)) {
      const key = expected.secretKeys[clientId];
      if (key === undefined) throw new Error(`client ${clientId} is not an app client whose secret the site supplies`);
      return [
        `Keycloak refused the secret of client ${clientId} at token introspection (${answer.status}): ${key}Env or ` +
          `${key}File must hold the current secret from the Credentials tab of ${clientId}, which must be confidential`,
      ];
    }
    return [`token introspection as client ${clientId} answered ${answer.status}`];
  });
}

function tokenFindings(observed: ManualKeycloakObservation): string[] {
  const platform = APP_CLIENT_IDS.platform;
  const { token } = observed;
  if ("error" in token) return [`the client_credentials token request of ${platform} failed: ${token.error}`];
  if (token.status === 200) return [];
  // A refused secret is named already, and it refuses the token request as well.
  const secret = observed.introspection.find((entry) => entry.clientId === platform)?.answer;
  if (secret !== undefined && "status" in secret && refused(secret.status)) return [];
  return [
    `client ${platform} got no token through client_credentials (${token.status}): turn on its service account ` +
      "(Service accounts roles), which Platform reads the directory with",
  ];
}

/** The findings of an Admin API read that needs `role`, or undefined when it was answered with 200. */
function adminReadFinding(what: string, answer: HttpAnswer<unknown>, realm: string, role: string): string | undefined {
  if ("error" in answer) return `${what} as the service account of ${APP_CLIENT_IDS.platform} failed: ${answer.error}`;
  if (answer.status === 200) return undefined;
  if (answer.status === 403) {
    return (
      `the service account of client ${APP_CLIENT_IDS.platform} cannot ${what} of realm ${realm} (403): give it the ` +
      `realm-management role ${role}, which Platform's session recheck, directory sync and grant search need`
    );
  }
  return `${what} as the service account of ${APP_CLIENT_IDS.platform} answered ${answer.status}`;
}

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);

/** How a configured app client differs from the one the export creates, as far as view-clients reads it. */
function appClientFindings(desired: DesiredClient, live: ClientRepresentation): string[] {
  const wanted = desired.representation;
  const clientId = wanted.clientId;
  const findings: string[] = [];
  const redirects = live.redirectUris ?? [];
  if (!sameSet(redirects, wanted.redirectUris ?? [])) {
    findings.push(
      `client ${clientId} has the redirect URIs [${redirects.join(", ")}], and the export needs exactly ` +
        `[${(wanted.redirectUris ?? []).join(", ")}]`,
    );
  }
  const postLogout = wanted.attributes?.["post.logout.redirect.uris"];
  const livePostLogout = (live.attributes?.["post.logout.redirect.uris"] ?? "").split("##").filter((uri) => uri !== "");
  if (postLogout !== undefined && !livePostLogout.includes(postLogout)) {
    findings.push(`client ${clientId} does not list ${postLogout} among its valid post logout redirect URIs`);
  }
  const pkce = live.attributes?.["pkce.code.challenge.method"];
  if (pkce !== "S256") {
    findings.push(`client ${clientId} has the PKCE method ${pkce === undefined || pkce === "" ? "(none)" : pkce}, and the export needs S256`);
  }
  if (live.publicClient === true) findings.push(`client ${clientId} is public, and the export needs Client authentication on`);
  if (live.standardFlowEnabled !== true) findings.push(`client ${clientId} has the standard flow off, and both apps sign in with it`);
  const defaults = live.defaultClientScopes ?? [];
  for (const scope of desired.defaultClientScopes ?? []) {
    if (!defaults.includes(scope)) {
      findings.push(`client ${clientId} lacks the default client scope ${scope}, which carries the claim libredb_roles`);
    }
  }
  if (wanted.attributes?.["use.refresh.tokens"] === "true" && live.attributes?.["use.refresh.tokens"] === "false") {
    findings.push(
      `client ${clientId} has Use refresh tokens off, and Platform refuses a Keycloak sign-in without a refresh token`,
    );
  }
  findings.push(
    ...pairwiseFindings(clientId, live.protocolMappers ?? []).map((finding) => `${finding}, ${PAIRWISE_CONSEQUENCE}`),
  );
  return findings;
}

function clientFindings(
  directory: NonNullable<ManualKeycloakObservation["directory"]>,
  expected: ManualKeycloakExpectations,
): string[] {
  const findings: string[] = [];
  for (const { clientId, answer } of directory.clients) {
    const problem = adminReadFinding(`read client ${clientId}`, answer, expected.realm, "view-clients");
    if (problem !== undefined) {
      findings.push(problem);
      // Every client read needs the same role, so one refusal says it for all of them.
      if ("status" in answer && answer.status === 403) return findings;
      continue;
    }
    const [live] = (answer as { body?: ClientRepresentation[] }).body ?? [];
    if (live === undefined) {
      findings.push(`realm ${expected.realm} has no client ${clientId}; create it from the installer's export`);
      continue;
    }
    if (clientId === ROLE_CLIENT_ID) {
      const roles = directory.roles;
      if (roles === undefined) continue;
      const problem = adminReadFinding(`read the roles of client ${clientId}`, roles, expected.realm, "view-clients");
      if (problem !== undefined) {
        findings.push(problem);
        continue;
      }
      const names = (roles as { body?: string[] }).body ?? [];
      for (const role of expected.roles.filter((name) => !names.includes(name))) {
        findings.push(`client ${clientId} lacks the role ${role}`);
      }
      continue;
    }
    const desired = expected.appClients.find((client) => client.representation.clientId === clientId);
    if (desired !== undefined) findings.push(...appClientFindings(desired, live));
  }
  return findings;
}

/** Every finding of the observed realm against the expectations, in the order the check reads them. */
export function manualKeycloakFindings(
  observed: ManualKeycloakObservation,
  expected: ManualKeycloakExpectations,
): string[] {
  const findings = [...discoveryFindings(observed), ...secretFindings(observed, expected), ...tokenFindings(observed)];
  const { directory } = observed;
  if (directory === undefined) return findings;
  const users = adminReadFinding("list the users", directory.users, expected.realm, "view-users");
  if (users !== undefined) findings.push(users);
  findings.push(...clientFindings(directory, expected));
  return findings;
}

/** Throws ManualKeycloakError, exit 3, naming every finding of the observed realm. */
export function checkManualKeycloak(observed: ManualKeycloakObservation, expected: ManualKeycloakExpectations): void {
  const findings = manualKeycloakFindings(observed, expected);
  if (findings.length > 0) throw new ManualKeycloakError(expected.realm, findings);
}
