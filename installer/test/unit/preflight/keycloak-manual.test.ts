import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../../src/cli/exit-codes";
import { loadConfig } from "../../../src/config/load";
import { desiredKeycloak } from "../../../src/keycloak/desired";
import type { ClientRepresentation } from "../../../src/keycloak/representations";
import { computeDesired } from "../../../src/model/desired";
import {
  checkManualKeycloak,
  manualExpectations,
  manualKeycloakFindings,
  ManualKeycloakError,
  type ManualKeycloakObservation,
} from "../../../src/preflight/keycloak-manual";
import { MANUAL_KEYCLOAK_SETS, PASSWORD_LOCATIONS } from "../keycloak/fixture";
import { manifestFixture } from "../release/fixture";

const root = join(import.meta.dir, "..", "..", "..");
const config = loadConfig({
  file: join(root, "test", "fixtures", "configs", "docker-minimal.yaml"),
  sets: [...MANUAL_KEYCLOAK_SETS, "keycloak.realm=corp"],
});
const installation = computeDesired(config, manifestFixture());
const desired = desiredKeycloak({ installation, keycloak: config.keycloak, clientSecrets: undefined, passwordLocations: PASSWORD_LOCATIONS });
const EXPECTED = manualExpectations(desired, installation.issuer);
const ISSUER = "https://auth.libredb.test/realms/corp";

/** The clients as view-clients reads them in a realm configured exactly from the export. */
function liveClients(): Record<string, ClientRepresentation> {
  const live = (clientId: string) => {
    const client = desired.appClients.find((candidate) => candidate.representation.clientId === clientId);
    if (client === undefined) throw new Error(`no app client ${clientId}`);
    return {
      ...client.representation,
      defaultClientScopes: ["web-origins", "acr", "profile", "roles", "basic", "email", "libredb-roles"],
      protocolMappers: [],
    };
  };
  return {
    libredb: { ...desired.roleClient.representation },
    "libredb-studio": live("libredb-studio"),
    "libredb-platform": live("libredb-platform"),
  };
}

function observation(clients = liveClients(), overrides: Partial<ManualKeycloakObservation> = {}): ManualKeycloakObservation {
  return {
    issuer: ISSUER,
    realm: "corp",
    discovery: { status: 200, body: { issuer: ISSUER } },
    introspection: [
      { clientId: "libredb-studio", answer: { status: 200 } },
      { clientId: "libredb-platform", answer: { status: 200 } },
    ],
    token: { status: 200 },
    directory: {
      users: { status: 200, body: [] },
      clients: ["libredb", "libredb-studio", "libredb-platform"].map((clientId) => ({
        clientId,
        answer: { status: 200, body: clients[clientId] === undefined ? [] : [clients[clientId] as ClientRepresentation] },
      })),
      roles: { status: 200, body: ["admin", "user"] },
    },
    ...overrides,
  };
}

describe("manualKeycloakFindings", () => {
  test("a realm configured from the export passes with the two client secrets", () => {
    expect(manualKeycloakFindings(observation(), EXPECTED)).toEqual([]);
    expect(() => checkManualKeycloak(observation(), EXPECTED)).not.toThrow();
    expect(EXPECTED.roles).toEqual(["admin", "user"]);
  });

  test("names a discovery document that fails, answers another status or names another issuer", () => {
    const url = `${ISSUER}/.well-known/openid-configuration`;
    expect(manualKeycloakFindings(observation(undefined, { discovery: { error: "unable to verify the first certificate" } }), EXPECTED)).toEqual([
      `GET ${url} failed: unable to verify the first certificate`,
    ]);
    expect(manualKeycloakFindings(observation(undefined, { discovery: { status: 404 } }), EXPECTED)).toEqual([
      `GET ${url} answered 404; realm corp must exist there`,
    ]);
    expect(manualKeycloakFindings(observation(undefined, { discovery: { status: 200, body: { issuer: undefined } } }), EXPECTED)).toEqual([
      `${url} names the issuer (none), and both apps expect ${ISSUER}; keycloak.external.baseUrl must be the URL that Keycloak announces`,
    ]);
  });

  test("names each refused client secret with its reference, and leaves the token of a refused platform secret unnamed", () => {
    const refused = observation(undefined, {
      introspection: [
        { clientId: "libredb-studio", answer: { status: 401 } },
        { clientId: "libredb-platform", answer: { status: 400 } },
      ],
      token: { status: 401 },
      directory: undefined,
    });
    expect(manualKeycloakFindings(refused, EXPECTED)).toEqual([
      "Keycloak refused the secret of client libredb-studio at token introspection (401): " +
        "keycloak.external.studioClientSecretEnv or keycloak.external.studioClientSecretFile must hold the current " +
        "secret from the Credentials tab of libredb-studio, which must be confidential",
      "Keycloak refused the secret of client libredb-platform at token introspection (400): " +
        "keycloak.external.platformClientSecretEnv or keycloak.external.platformClientSecretFile must hold the current " +
        "secret from the Credentials tab of libredb-platform, which must be confidential",
    ]);
    const other = observation(undefined, {
      introspection: [
        { clientId: "libredb-studio", answer: { status: 503 } },
        { clientId: "libredb-platform", answer: { error: "connection refused" } },
      ],
      token: { error: "connection refused" },
      directory: undefined,
    });
    expect(manualKeycloakFindings(other, EXPECTED)).toEqual([
      "token introspection as client libredb-studio answered 503",
      "token introspection as client libredb-platform failed: connection refused",
      "the client_credentials token request of libredb-platform failed: connection refused",
    ]);
    const unknown = observation(undefined, { introspection: [{ clientId: "corp-app", answer: { status: 401 } }] });
    expect(() => manualKeycloakFindings(unknown, EXPECTED)).toThrow(
      "client corp-app is not an app client whose secret the site supplies",
    );
  });

  test("names a libredb-platform without a service account", () => {
    expect(manualKeycloakFindings(observation(undefined, { token: { status: 400 }, directory: undefined }), EXPECTED)).toEqual([
      "client libredb-platform got no token through client_credentials (400): turn on its service account " +
        "(Service accounts roles), which Platform reads the directory with",
    ]);
  });

  test("names a service account without view-users or view-clients, once for every client read", () => {
    const observed = observation();
    const directory = observed.directory as NonNullable<ManualKeycloakObservation["directory"]>;
    directory.users = { status: 403 };
    directory.clients = directory.clients.map((entry) => ({ ...entry, answer: { status: 403 } }));
    const findings = manualKeycloakFindings(observed, EXPECTED);
    expect(findings).toEqual([
      "the service account of client libredb-platform cannot list the users of realm corp (403): give it the " +
        "realm-management role view-users, which Platform's session recheck, directory sync and grant search need",
      "the service account of client libredb-platform cannot read client libredb of realm corp (403): give it the " +
        "realm-management role view-clients, which Platform's session recheck, directory sync and grant search need",
    ]);
    let error: unknown;
    try {
      checkManualKeycloak(observed, EXPECTED);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ManualKeycloakError);
    expect((error as ManualKeycloakError).exitCode).toBe(ExitCode.PreflightFailed);
    expect((error as ManualKeycloakError).findings).toEqual(findings);
    expect((error as Error).message).toStartWith(
      "the check of realm corp, which the site configured from the installer's export (keycloak.external.provisioning manual), failed:\n  the service account",
    );
  });

  test("names other answers of the Admin API reads", () => {
    const observed = observation();
    const directory = observed.directory as NonNullable<ManualKeycloakObservation["directory"]>;
    directory.users = { error: "socket hang up" };
    directory.clients[1] = { clientId: "libredb-studio", answer: { status: 500 } };
    directory.roles = { status: 404 };
    expect(manualKeycloakFindings(observed, EXPECTED)).toEqual([
      "list the users as the service account of libredb-platform failed: socket hang up",
      "read the roles of client libredb as the service account of libredb-platform answered 404",
      "read client libredb-studio as the service account of libredb-platform answered 500",
    ]);
  });

  test("names a missing client and a missing role of client libredb, and skips roles it could not read", () => {
    const clients = liveClients();
    delete clients["libredb-studio"];
    const observed = observation(clients);
    const directory = observed.directory as NonNullable<ManualKeycloakObservation["directory"]>;
    directory.roles = { status: 200, body: ["user"] };
    expect(manualKeycloakFindings(observed, EXPECTED)).toEqual([
      "client libredb lacks the role admin",
      "realm corp has no client libredb-studio; create it from the installer's export",
    ]);
    delete directory.roles;
    expect(manualKeycloakFindings(observed, EXPECTED)).toEqual([
      "realm corp has no client libredb-studio; create it from the installer's export",
    ]);
    directory.roles = { status: 200 };
    directory.clients[1] = { clientId: "libredb-studio", answer: { status: 200 } };
    expect(manualKeycloakFindings(observed, EXPECTED)).toEqual([
      "client libredb lacks the role admin",
      "client libredb lacks the role user",
      "realm corp has no client libredb-studio; create it from the installer's export",
    ]);
  });

  test("names every difference of an app client from its expected configuration that view-clients reads", () => {
    const clients = liveClients();
    const studio = clients["libredb-studio"] as ClientRepresentation;
    clients["libredb-studio"] = {
      ...studio,
      redirectUris: ["https://studio.libredb.test/*"],
      publicClient: true,
      standardFlowEnabled: false,
      defaultClientScopes: ["profile", "email"],
      attributes: { "post.logout.redirect.uris": "https://other.test/login##+" },
      protocolMappers: [{ name: "pairwise", protocol: "openid-connect", protocolMapper: "oidc-sha256-pairwise-sub-mapper", config: {} }],
    };
    const platform = clients["libredb-platform"] as ClientRepresentation;
    clients["libredb-platform"] = {
      ...platform,
      redirectUris: undefined,
      defaultClientScopes: undefined,
      protocolMappers: undefined,
      attributes: { ...platform.attributes, "pkce.code.challenge.method": "plain", "use.refresh.tokens": "false" },
    };
    const extra = clients["libredb"] as ClientRepresentation;
    clients["libredb"] = { ...extra, attributes: undefined };
    expect(manualKeycloakFindings(observation(clients), EXPECTED)).toEqual([
      "client libredb-studio has the redirect URIs [https://studio.libredb.test/*], and the export needs exactly " +
        "[https://studio.libredb.test/api/auth/oidc/callback]",
      "client libredb-studio does not list https://studio.libredb.test/login among its valid post logout redirect URIs",
      "client libredb-studio has the PKCE method (none), and the export needs S256",
      "client libredb-studio is public, and the export needs Client authentication on",
      "client libredb-studio has the standard flow off, and both apps sign in with it",
      "client libredb-studio lacks the default client scope libredb-roles, which carries the claim libredb_roles",
      "client libredb-studio has the mapper pairwise of type oidc-sha256-pairwise-sub-mapper, which would change the " +
        "sub claim that Studio and Platform key every user by",
      "client libredb-platform has the redirect URIs [], and the export needs exactly " +
        "[https://platform.libredb.test/api/auth/callback/keycloak]",
      "client libredb-platform has the PKCE method plain, and the export needs S256",
      "client libredb-platform lacks the default client scope libredb-roles, which carries the claim libredb_roles",
      "client libredb-platform has Use refresh tokens off, and Platform refuses a Keycloak sign-in without a refresh token",
    ]);
  });
});

describe("manualKeycloakFindings with the mobile app", () => {
  const mobileConfig = loadConfig({
    file: join(root, "test", "fixtures", "configs", "docker-minimal.yaml"),
    sets: [...MANUAL_KEYCLOAK_SETS, "keycloak.realm=corp", "mobile.enabled=true"],
  });
  const mobileDesired = desiredKeycloak({
    installation: computeDesired(mobileConfig, manifestFixture()),
    keycloak: mobileConfig.keycloak,
    clientSecrets: undefined,
    passwordLocations: PASSWORD_LOCATIONS,
  });
  const expected = manualExpectations(mobileDesired, installation.issuer);
  const found = mobileDesired.appClients.find((candidate) => candidate.representation.clientId === "libredb-mobile");
  if (found === undefined) throw new Error("no client libredb-mobile");
  const client = found;

  /** libredb-mobile as view-clients reads it in a realm configured from the export, with its mapper as Keycloak keeps it. */
  function liveMobile(): ClientRepresentation {
    return {
      ...client.representation,
      defaultClientScopes: ["web-origins", "acr", "profile", "roles", "basic", "email", "libredb-roles"],
      protocolMappers: client.protocolMappers.map((mapper) => ({
        ...mapper,
        name: "audience",
        id: "m1",
        config: { ...mapper.config, "lightweight.claim": "false", "included.client.audience": "" },
      })),
    };
  }

  function mobileObservation(mobile: ClientRepresentation | undefined): ManualKeycloakObservation {
    const observed = observation(liveClients());
    const directory = observed.directory as NonNullable<ManualKeycloakObservation["directory"]>;
    directory.clients.push({ clientId: "libredb-mobile", answer: { status: 200, body: mobile === undefined ? [] : [mobile] } });
    return observed;
  }

  test("expects libredb-mobile as the export creates it, and a realm configured from the export passes", () => {
    expect(expected.appClients.map((candidate) => candidate.representation.clientId)).toEqual([
      "libredb-studio",
      "libredb-platform",
      "libredb-mobile",
    ]);
    expect(manualKeycloakFindings(mobileObservation(liveMobile()), expected)).toEqual([]);
  });

  test("names a missing libredb-mobile", () => {
    expect(manualKeycloakFindings(mobileObservation(undefined), expected)).toEqual([
      "realm corp has no client libredb-mobile; create it from the installer's export",
    ]);
  });

  test("names every difference of libredb-mobile from the export that view-clients reads", () => {
    const mobile: ClientRepresentation = {
      ...liveMobile(),
      redirectUris: ["org.libredb.mobile:/*"],
      publicClient: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: true,
      directAccessGrantsEnabled: true,
      defaultClientScopes: ["profile", "roles"],
      attributes: { "post.logout.redirect.uris": "+" },
      protocolMappers: [
        {
          name: "audience",
          protocol: "openid-connect",
          protocolMapper: "oidc-audience-mapper",
          config: { "included.custom.audience": "libredb-studio", "access.token.claim": "true" },
        },
      ],
    };
    expect(manualKeycloakFindings(mobileObservation(mobile), expected)).toEqual([
      "client libredb-mobile has the redirect URIs [org.libredb.mobile:/*], and the export needs exactly " +
        "[org.libredb.mobile:/oauth2redirect]",
      "client libredb-mobile does not list org.libredb.mobile:/oauth2redirect among its valid post logout redirect URIs",
      "client libredb-mobile has the PKCE method (none), and the export needs S256",
      "client libredb-mobile is confidential, and the export needs Client authentication off, because the mobile app " +
        "keeps no secret",
      "client libredb-mobile has the standard flow off, and the mobile app signs in with it",
      "client libredb-mobile has the implicit flow on, and the export needs it off",
      "client libredb-mobile has Direct access grants on, and the export needs them off, so that no app signs in " +
        "with a password in place of the browser",
      "client libredb-mobile lacks the default client scope basic, which carries the claim sub",
      "client libredb-mobile lacks the default client scope email, which carries the claim email",
      "client libredb-mobile lacks the default client scope libredb-roles, which carries the claim libredb_roles",
      "client libredb-mobile lacks a protocol mapper of type oidc-audience-mapper with included.custom.audience " +
        "libredb-studio-api, id.token.claim false, access.token.claim true and introspection.token.claim true, which " +
        "puts the audience that Studio's bearer channel checks into the access token",
    ]);
  });
});
