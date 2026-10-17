import { describe, expect, test } from "bun:test";
import { KeycloakConvergeError, planKeycloak, type KeycloakAction } from "../../../src/keycloak/planner";
import { adminRequest } from "../../../src/keycloak/requests";
import type { ObservedKeycloak, RealmRepresentation } from "../../../src/keycloak/representations";
import {
  CLIENT_SECRETS,
  clientOf,
  convergedFixture,
  desiredFixture,
  EXTERNAL_KEYCLOAK_SETS,
  fakeRequestContext,
  observedFixture,
  realmOf,
  userOf,
} from "./fixture";

const REALM = "/admin/realms/libredb";
const STUDIO_REDIRECT = "https://studio.libredb.test/api/auth/oidc/callback";

const summaries = (actions: readonly KeycloakAction[]) => actions.map((action) => action.summary);

function refusal(plan: () => unknown): KeycloakConvergeError {
  try {
    plan();
  } catch (error) {
    if (error instanceof KeycloakConvergeError) return error;
    throw error;
  }
  throw new Error("the plan was not refused");
}

function scopeOf(observed: ObservedKeycloak, name: string) {
  const scope = observed.clientScopes.find((candidate) => candidate.representation.name === name);
  if (scope === undefined) throw new Error(`the fixture has no client scope ${name}`);
  return scope;
}

/** The settings Keycloak 26.8.1 gives a realm created without them, as the handover created it before the hardening. */
function withKeycloakDefaults(realm: RealmRepresentation): void {
  realm.bruteForceProtected = false;
  realm.failureFactor = 30;
  realm.maxSecondaryAuthFailures = 0;
  delete realm.passwordPolicy;
  realm.eventsEnabled = false;
  delete realm.eventsExpiration;
  realm.adminEventsEnabled = false;
  realm.adminEventsDetailsEnabled = false;
  const { adminEventsExpiration: _expiration, ...attributes } = realm.attributes ?? {};
  realm.attributes = attributes;
}

describe("planKeycloak", () => {
  test("an empty realm plans the exact create sequence for the LibreDB Keycloak objects", async () => {
    const actions = planKeycloak(desiredFixture(), observedFixture("empty-realm"));
    expect(summaries(actions)).toEqual([
      "create client libredb",
      "create role admin on client libredb",
      "create role user on client libredb",
      "create client scope libredb-roles",
      "map the roles libredb:admin and libredb:user into client scope libredb-roles",
      "create client libredb-studio",
      "add default client scope libredb-roles to client libredb-studio",
      "create client libredb-platform",
      "add default client scope libredb-roles to client libredb-platform",
      "map the roles realm-management:view-users and realm-management:view-clients into the scope of client libredb-platform",
      "grant realm-management:view-users and realm-management:view-clients to the service account of client libredb-platform",
      "create user libredb-admin with a temporary password in /opt/libredb/secrets/first-admin.txt and the required actions UPDATE_PASSWORD and CONFIGURE_TOTP",
      "grant libredb:admin to user libredb-admin",
      "create user libredb-user-manager with a temporary password in /opt/libredb/secrets/user-manager.txt and the required actions UPDATE_PASSWORD and CONFIGURE_TOTP",
      "grant realm-management:manage-users, realm-management:view-users, realm-management:query-groups and realm-management:view-clients to user libredb-user-manager",
    ]);

    const context = fakeRequestContext({ "libredb-admin": "first-admin-temporary", "libredb-user-manager": "manager-temporary" });
    const requests = await Promise.all(actions.map((action) => adminRequest("libredb", action, context)));
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST ${REALM}/clients`,
      `POST ${REALM}/clients/cid-libredb/roles`,
      `POST ${REALM}/clients/cid-libredb/roles`,
      `POST ${REALM}/client-scopes`,
      `POST ${REALM}/client-scopes/sid-libredb-roles/scope-mappings/clients/cid-libredb`,
      `POST ${REALM}/clients`,
      `PUT ${REALM}/clients/cid-libredb-studio/default-client-scopes/sid-libredb-roles`,
      `POST ${REALM}/clients`,
      `PUT ${REALM}/clients/cid-libredb-platform/default-client-scopes/sid-libredb-roles`,
      `POST ${REALM}/clients/cid-libredb-platform/scope-mappings/clients/cid-realm-management`,
      `POST ${REALM}/users/sa-libredb-platform/role-mappings/clients/cid-realm-management`,
      `POST ${REALM}/users`,
      `POST ${REALM}/users/uid-libredb-admin/role-mappings/clients/cid-libredb`,
      `POST ${REALM}/users`,
      `POST ${REALM}/users/uid-libredb-user-manager/role-mappings/clients/cid-realm-management`,
    ]);

    const managed = { "libredb.managed": "true" };
    const noOtherGrant = {
      "oauth2.device.authorization.grant.enabled": "false",
      "oidc.ciba.grant.enabled": "false",
      "standard.token.exchange.enabled": "false",
    };
    expect(requests[0]?.body).toEqual({
      clientId: "libredb",
      name: "LibreDB roles",
      description: "Holds the LibreDB client roles admin and user. Every flow is disabled and no secret is used.",
      protocol: "openid-connect",
      enabled: true,
      publicClient: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      attributes: { ...managed, ...noOtherGrant },
    });
    expect(requests[1]?.body).toEqual({
      name: "admin",
      description: "LibreDB administrator",
      attributes: { "libredb.managed": ["true"] },
    });
    expect(requests[3]?.body).toEqual({
      name: "libredb-roles",
      description: "The LibreDB client roles in the claim libredb_roles",
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "false", "display.on.consent.screen": "false", ...managed },
      protocolMappers: [
        {
          name: "libredb roles",
          protocol: "openid-connect",
          protocolMapper: "oidc-usermodel-client-role-mapper",
          consentRequired: false,
          config: {
            "usermodel.clientRoleMapping.clientId": "libredb",
            "claim.name": "libredb_roles",
            multivalued: "true",
            "jsonType.label": "String",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true",
            "introspection.token.claim": "true",
          },
        },
      ],
    });
    expect(requests[4]?.body).toEqual([
      { id: "rid-libredb-admin", name: "admin" },
      { id: "rid-libredb-user", name: "user" },
    ]);
    const appClient = (
      clientId: string,
      name: string,
      secret: string,
      host: string,
      redirectPath: string,
      serviceAccounts: boolean,
      attributes: Record<string, string> = {},
    ) => ({
      clientId,
      name,
      protocol: "openid-connect",
      enabled: true,
      publicClient: false,
      clientAuthenticatorType: "client-secret",
      secret,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: serviceAccounts,
      redirectUris: [`https://${host}${redirectPath}`],
      attributes: {
        ...managed,
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": `https://${host}/login`,
        ...noOtherGrant,
        ...attributes,
      },
    });
    expect(requests[5]?.body).toEqual(
      appClient("libredb-studio", "LibreDB Studio", CLIENT_SECRETS.studio, "studio.libredb.test", "/api/auth/oidc/callback", false),
    );
    expect(requests[7]?.body).toEqual(
      appClient(
        "libredb-platform",
        "LibreDB Platform",
        CLIENT_SECRETS.platform,
        "platform.libredb.test",
        "/api/auth/callback/keycloak",
        true,
        { "use.refresh.tokens": "true" },
      ),
    );
    const realmManagement = (role: string) => ({ id: `rid-realm-management-${role}`, name: role });
    expect(requests[9]?.body).toEqual([realmManagement("view-users"), realmManagement("view-clients")]);
    expect(requests[10]?.body).toEqual([realmManagement("view-users"), realmManagement("view-clients")]);
    expect(requests[11]?.body).toEqual({
      username: "libredb-admin",
      enabled: true,
      requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"],
      credentials: [{ type: "password", value: "first-admin-temporary", temporary: true }],
    });
    expect(requests[13]?.body).toEqual({
      username: "libredb-user-manager",
      enabled: true,
      requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"],
      credentials: [{ type: "password", value: "manager-temporary", temporary: true }],
    });
  });

  test("a drifted redirect URI on libredb-studio plans one client update that PUTs the merged representation", async () => {
    const observed = observedFixture("drifted-redirect");
    const live = clientOf(observed, "libredb-studio").representation;
    expect(live.redirectUris).not.toEqual([STUDIO_REDIRECT]);

    const actions = planKeycloak(desiredFixture(), observed);
    expect(summaries(actions)).toEqual(["update client libredb-studio (redirectUris)"]);

    const request = await adminRequest("libredb", actions[0] as KeycloakAction, fakeRequestContext());
    expect({ method: request.method, path: request.path, expected: request.expected }).toEqual({
      method: "PUT",
      path: `${REALM}/clients/${live.id}`,
      expected: [204],
    });
    // Every field the installer does not own goes back as Keycloak returned it; the protocol mappers and the
    // client scopes have endpoints of their own, so the update leaves them out and Keycloak keeps them.
    const { protocolMappers, defaultClientScopes, optionalClientScopes, ...kept } = live;
    expect(protocolMappers).toBeDefined();
    expect(defaultClientScopes).toContain("libredb-roles");
    expect(optionalClientScopes).toBeDefined();
    expect(request.body).toEqual({ ...kept, redirectUris: [STUDIO_REDIRECT] });
    expect(kept.webOrigins).toBeDefined();
    expect(kept.frontchannelLogout).toBeDefined();
    expect(kept.attributes?.["backchannel.logout.session.required"]).toBeDefined();
  });

  test("an unmarked client named libredb-studio is refused with exit 6", () => {
    const error = refusal(() => planKeycloak(desiredFixture(), observedFixture("unmarked-client")));
    expect(error.exitCode).toBe(6);
    expect(error.message).toContain("client libredb-studio");
    expect(error.message).toContain("libredb.managed=true");
  });

  test("a converged realm plans no action", () => {
    expect(planKeycloak(desiredFixture(), convergedFixture())).toEqual([]);
  });

  test("the first admin holds only libredb:admin and the user manager only manage-users, view-users, query-groups and view-clients", () => {
    const grants = planKeycloak(desiredFixture(), observedFixture("empty-realm")).flatMap((action) =>
      action.kind === "map-roles" && action.subject.type === "user"
        ? [{ username: action.subject.username, roleClientId: action.roleClientId, roles: action.roles }]
        : [],
    );
    expect(grants).toEqual([
      { username: "libredb-admin", roleClientId: "libredb", roles: ["admin"] },
      {
        username: "libredb-user-manager",
        roleClientId: "realm-management",
        roles: ["manage-users", "view-users", "query-groups", "view-clients"],
      },
    ]);

    // A role given to either account later is taken back, so the first admin holds no realm-management role and the
    // user manager no libredb role.
    const observed = convergedFixture();
    userOf(observed, "libredb-admin").clientRoles["realm-management"] = ["manage-users"];
    userOf(observed, "libredb-user-manager").clientRoles.libredb = ["admin"];
    expect(summaries(planKeycloak(desiredFixture(), observed))).toEqual([
      "revoke realm-management:manage-users from user libredb-admin",
      "revoke libredb:admin from user libredb-user-manager",
    ]);
  });

  test("a pairwise subject mapper on libredb-platform is refused with exit 3 naming the client and the mapper", () => {
    const error = refusal(() => planKeycloak(desiredFixture(), observedFixture("pairwise")));
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain("client libredb-platform");
    expect(error.message).toContain("oidc-sha256-pairwise-sub-mapper");
    expect(error.message).toContain("sub");
  });

  test("a client secret regenerated in the console plans one update back to the stored secret", async () => {
    const observed = convergedFixture();
    clientOf(observed, "libredb-platform").representation.secret = "regenerated-in-the-console";
    const actions = planKeycloak(desiredFixture(), observed);
    expect(summaries(actions)).toEqual(["update client libredb-platform (secret)"]);
    const request = await adminRequest("libredb", actions[0] as KeycloakAction, fakeRequestContext());
    expect((request.body as { secret: string }).secret).toBe(CLIENT_SECRETS.platform);
  });

  test("a turned-off flow and a changed post-logout URI are converged, and fields the installer does not own are kept", async () => {
    const observed = convergedFixture();
    const studio = clientOf(observed, "libredb-studio").representation;
    studio.directAccessGrantsEnabled = true;
    studio.fullScopeAllowed = false;
    studio.attributes = { ...studio.attributes, "post.logout.redirect.uris": "https://elsewhere.test/login", custom: "kept" };
    const actions = planKeycloak(desiredFixture(), observed);
    expect(summaries(actions)).toEqual(["update client libredb-studio (directAccessGrantsEnabled, post.logout.redirect.uris)"]);
    const body = (await adminRequest("libredb", actions[0] as KeycloakAction, fakeRequestContext())).body as typeof studio;
    expect(body.directAccessGrantsEnabled).toBe(false);
    expect(body.fullScopeAllowed).toBe(false);
    expect(body.attributes?.["post.logout.redirect.uris"]).toBe("https://studio.libredb.test/login");
    expect(body.attributes?.custom).toBe("kept");
  });

  test("a default scope attached as optional is moved to the default scopes, and a missing one is added", () => {
    const observed = convergedFixture();
    const studio = clientOf(observed, "libredb-studio").representation;
    studio.defaultClientScopes = (studio.defaultClientScopes ?? []).filter((name) => name !== "profile" && name !== "libredb-roles");
    const platform = clientOf(observed, "libredb-platform").representation;
    platform.defaultClientScopes = (platform.defaultClientScopes ?? []).filter((name) => name !== "email");
    platform.optionalClientScopes = [...(platform.optionalClientScopes ?? []), "email"];
    expect(summaries(planKeycloak(desiredFixture(), observed))).toEqual([
      "add default client scope profile to client libredb-studio",
      "add default client scope libredb-roles to client libredb-studio",
      "remove client scope email from the optional scopes of client libredb-platform",
      "add default client scope email to client libredb-platform",
    ]);
  });

  test("the libredb-roles scope regains its owned attributes, its one mapper and a lost scope mapping", () => {
    const observed = convergedFixture();
    const scope = scopeOf(observed, "libredb-roles");
    scope.representation.attributes = { ...scope.representation.attributes, "include.in.token.scope": "true", extra: "kept" };
    const [mapper] = scope.representation.protocolMappers ?? [];
    if (mapper === undefined) throw new Error("the fixture scope has no mapper");
    scope.representation.protocolMappers = [
      { ...mapper, config: { ...mapper.config, "claim.name": "roles", "lightweight.claim": "false" } },
      { id: "foreign-mapper", name: "audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper", config: {} },
    ];
    scope.scopeMappings = { libredb: ["admin"] };
    const actions = planKeycloak(desiredFixture(), observed);
    expect(summaries(actions)).toEqual([
      "update client scope libredb-roles (include.in.token.scope)",
      "update protocol mapper libredb roles in client scope libredb-roles (claim.name)",
      "delete protocol mapper audience from client scope libredb-roles",
      "map the roles libredb:user into client scope libredb-roles",
    ]);
    const update = actions[1];
    if (update?.kind !== "update-mapper") throw new Error("expected a mapper update");
    expect(update.mapper.config["claim.name"]).toBe("libredb_roles");
    expect(update.mapper.config["lightweight.claim"]).toBe("false");
    const scopeUpdate = actions[0];
    if (scopeUpdate?.kind !== "update-client-scope") throw new Error("expected a client scope update");
    expect(scopeUpdate.representation.attributes?.extra).toBe("kept");
    expect(scopeUpdate.representation.protocolMappers).toBeUndefined();
  });

  test("a mapper of another type under the mapper's name is replaced, and a scope without a mapper gets one", () => {
    const observed = convergedFixture();
    const scope = scopeOf(observed, "libredb-roles");
    const [mapper] = scope.representation.protocolMappers ?? [];
    if (mapper === undefined) throw new Error("the fixture scope has no mapper");
    scope.representation.protocolMappers = [{ ...mapper, protocolMapper: "oidc-usermodel-realm-role-mapper" }];
    expect(summaries(planKeycloak(desiredFixture(), observed))).toEqual([
      "delete protocol mapper libredb roles from client scope libredb-roles",
      "create protocol mapper libredb roles in client scope libredb-roles",
    ]);
    delete scope.representation.protocolMappers;
    expect(summaries(planKeycloak(desiredFixture(), observed))).toEqual([
      "create protocol mapper libredb roles in client scope libredb-roles",
    ]);

    // A mapper the converge must delete or update needs its id, which Keycloak always returns.
    scope.representation.protocolMappers = [{ name: "audience", protocol: "openid-connect", protocolMapper: "x", config: {} }];
    expect(() => planKeycloak(desiredFixture(), observed)).toThrow(
      "Keycloak returned the protocol mapper audience of client scope libredb-roles without an id",
    );
  });

  test("a deleted role is created again, and a role or client scope of the installer's names without the marker is refused with exit 6", () => {
    const observed = convergedFixture();
    const libredb = clientOf(observed, "libredb");
    // Keycloak drops a deleted role from every scope mapping too.
    libredb.roles = libredb.roles.filter((role) => role.name !== "user");
    scopeOf(observed, "libredb-roles").scopeMappings = { libredb: ["admin"] };
    expect(summaries(planKeycloak(desiredFixture(), observed))).toEqual([
      "create role user on client libredb",
      "map the roles libredb:user into client scope libredb-roles",
    ]);

    libredb.roles.push({ name: "user", description: "made by hand" });
    expect(refusal(() => planKeycloak(desiredFixture(), observed)).message).toContain("role libredb:user");

    const unmarkedScope = convergedFixture();
    scopeOf(unmarkedScope, "libredb-roles").representation.attributes = {};
    const error = refusal(() => planKeycloak(desiredFixture(), unmarkedScope));
    expect(error.exitCode).toBe(6);
    expect(error.message).toContain("client scope libredb-roles");
  });

  test("the platform service account and client scope converge on view-users and view-clients alone", () => {
    const observed = convergedFixture();
    const platform = clientOf(observed, "libredb-platform");
    if (platform.serviceAccount === undefined) throw new Error("the fixture has no service account");
    platform.serviceAccount.clientRoles["realm-management"] = ["view-users", "manage-users"];
    platform.scopeMappings["realm-management"] = ["view-users"];
    expect(summaries(planKeycloak(desiredFixture(), observed))).toEqual([
      "map the roles realm-management:view-clients into the scope of client libredb-platform",
      "grant realm-management:view-clients to the service account of client libredb-platform",
      "revoke realm-management:manage-users from the service account of client libredb-platform",
    ]);

    // A service account that was turned off is turned on by the update, then gets its roles.
    delete platform.serviceAccount;
    platform.representation.serviceAccountsEnabled = false;
    platform.scopeMappings["realm-management"] = ["view-users", "view-clients"];
    expect(summaries(planKeycloak(desiredFixture(), observed))).toEqual([
      "update client libredb-platform (serviceAccountsEnabled)",
      "grant realm-management:view-users and realm-management:view-clients to the service account of client libredb-platform",
    ]);
  });

  test("an account the state records as created is not created again after someone deleted it", () => {
    const observed = convergedFixture();
    observed.users = observed.users.filter((user) => user.username !== "libredb-admin");
    expect(observed.createdUsers).toContain("libredb-admin");
    expect(planKeycloak(desiredFixture(), observed)).toEqual([]);
  });

  test("an existing user of an account's name that the state does not record is refused with exit 6", () => {
    const observed = convergedFixture();
    observed.createdUsers = observed.createdUsers.filter((name) => name !== "libredb-admin");
    const error = refusal(() => planKeycloak(desiredFixture(), observed));
    expect(error.exitCode).toBe(6);
    expect(error.message).toContain("user libredb-admin");
  });

  test("with keycloak.userManager.enabled false the converge plans no user manager and leaves an existing one alone", () => {
    const disabled = desiredFixture(["keycloak.userManager.enabled=false"]);
    expect(summaries(planKeycloak(disabled, observedFixture("empty-realm"))).filter((summary) => summary.includes("user-manager"))).toEqual(
      [],
    );
    const observed = convergedFixture();
    userOf(observed, "libredb-user-manager").clientRoles.libredb = ["admin"];
    expect(planKeycloak(disabled, observed)).toEqual([]);
  });

  test("a reused realm plans no user manager and no realm-management role mapping unless keycloak.userManager.enabled is set", () => {
    const reused = [...EXTERNAL_KEYCLOAK_SETS, "keycloak.realm=corp"];
    const corp = observedFixture("empty-realm");
    corp.realm = "corp";
    // The realm-management grants of a plan, by whom they go to.
    const managementGrants = (actions: readonly KeycloakAction[]) =>
      actions.flatMap((action) =>
        action.kind === "map-roles" && action.roleClientId === "realm-management" ? [action.subject] : [],
      );
    const users = (actions: readonly KeycloakAction[]) =>
      actions.flatMap((action) => (action.kind === "create-user" ? [action.username] : []));

    // Only the service account of libredb-platform reads the directory; the customer's identity team manages users.
    const plain = planKeycloak(desiredFixture(reused), corp);
    expect(managementGrants(plain)).toEqual([{ type: "service-account", clientId: "libredb-platform" }]);
    expect(users(plain)).toEqual([]);

    // A first admin that the configuration asks for gets libredb:admin and still no realm-management role.
    const withAdmin = planKeycloak(desiredFixture([...reused, "keycloak.firstAdmin.enabled=true"]), corp);
    expect(managementGrants(withAdmin)).toEqual([{ type: "service-account", clientId: "libredb-platform" }]);
    expect(users(withAdmin)).toEqual(["libredb-admin"]);
    expect(summaries(withAdmin)).toContain("grant libredb:admin to user libredb-admin");

    const withManager = planKeycloak(desiredFixture([...reused, "keycloak.userManager.enabled=true"]), corp);
    expect(managementGrants(withManager)).toEqual([
      { type: "service-account", clientId: "libredb-platform" },
      { type: "user", username: "libredb-user-manager" },
    ]);
    expect(users(withManager)).toEqual(["libredb-user-manager"]);
  });

  test("libredb-platform keeps Use refresh tokens on, because Platform refuses a sign-in without a refresh token", () => {
    const platform = desiredFixture().appClients.find((client) => client.representation.clientId === "libredb-platform");
    expect(platform?.representation.attributes?.["use.refresh.tokens"]).toBe("true");
    const observed = convergedFixture();
    const live = clientOf(observed, "libredb-platform").representation;
    live.attributes = { ...live.attributes, "use.refresh.tokens": "false" };
    expect(summaries(planKeycloak(desiredFixture(), observed))).toEqual(["update client libredb-platform (use.refresh.tokens)"]);
  });

  test("a realm whose settings were loosened in the console plans one realm update that PUTs the realm as Keycloak holds it with the installer's settings put over it", async () => {
    const observed = convergedFixture();
    const live = realmOf(observed);
    live.bruteForceProtected = false;
    live.passwordPolicy = "length(8)";
    live.eventsEnabled = false;
    live.displayName = "Operations";
    live.attributes = { ...live.attributes, adminEventsExpiration: "3600", custom: "kept" };

    const actions = planKeycloak(desiredFixture(), observed);
    expect(summaries(actions)).toEqual([
      "update realm libredb (bruteForceProtected, passwordPolicy, eventsEnabled, adminEventsExpiration)",
    ]);
    const request = await adminRequest("libredb", actions[0] as KeycloakAction, fakeRequestContext());
    expect({ method: request.method, path: request.path, expected: request.expected }).toEqual({
      method: "PUT",
      path: REALM,
      expected: [204],
    });
    // Every setting the installer does not own goes back as Keycloak returned it, the marker and the console's own
    // display name and attribute among them.
    expect(request.body).toEqual({
      ...live,
      bruteForceProtected: true,
      passwordPolicy: "length(15) and notUsername and notEmail and passwordHistory(3)",
      eventsEnabled: true,
      attributes: { ...live.attributes, adminEventsExpiration: "7776000" },
    });
  });

  test("a realm the handover created before the hardening is updated before anything is created, so the password policy holds when the accounts get their temporary passwords", () => {
    const observed = observedFixture("empty-realm");
    withKeycloakDefaults(realmOf(observed));
    const [first, ...rest] = summaries(planKeycloak(desiredFixture(), observed));
    expect(first).toBe(
      "update realm libredb (bruteForceProtected, failureFactor, maxSecondaryAuthFailures, passwordPolicy, eventsEnabled, " +
        "eventsExpiration, adminEventsEnabled, adminEventsDetailsEnabled, adminEventsExpiration)",
    );
    expect(rest).toEqual(summaries(planKeycloak(desiredFixture(), observedFixture("empty-realm"))));
  });

  test("a reused realm keeps its own settings: the plan holds no realm update, whether or not the observation read the realm", () => {
    const reused = desiredFixture([...EXTERNAL_KEYCLOAK_SETS, "keycloak.realm=corp"]);
    expect(reused.realmSettings).toBeUndefined();
    const corp = observedFixture("empty-realm");
    corp.realm = "corp";
    // The customer's realm, with Keycloak's own settings and without the installer's marker.
    const realm = realmOf(corp);
    withKeycloakDefaults(realm);
    const { "libredb.managed": _marker, ...attributes } = realm.attributes ?? {};
    realm.attributes = attributes;
    const read = summaries(planKeycloak(reused, corp));
    expect(read.filter((summary) => summary.startsWith("update realm"))).toEqual([]);
    delete corp.realmRepresentation;
    expect(summaries(planKeycloak(reused, corp))).toEqual(read);
  });

  test("a managed realm without the libredb.managed marker is refused with exit 6, so the installer changes the settings of no realm it did not create", () => {
    const observed = convergedFixture();
    const realm = realmOf(observed);
    const { "libredb.managed": _marker, ...attributes } = realm.attributes ?? {};
    realm.attributes = attributes;
    const error = refusal(() => planKeycloak(desiredFixture(), observed));
    expect(error.exitCode).toBe(6);
    expect(error.message).toContain("realm libredb exists without the attribute libredb.managed=true");
  });

  test("an observation of a managed realm without the realm's representation is an error", () => {
    const observed = convergedFixture();
    delete observed.realmRepresentation;
    expect(() => planKeycloak(desiredFixture(), observed)).toThrow(
      "the observation of realm libredb holds no realm representation",
    );
  });

  test("a realm without a realm-management role the accounts need fails with exit 3 naming the role", () => {
    const observed = observedFixture("empty-realm");
    const management = clientOf(observed, "realm-management");
    management.roles = management.roles.filter((role) => role.name !== "query-groups");
    const error = refusal(() => planKeycloak(desiredFixture(), observed));
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain("realm-management role query-groups");

    observed.clients = observed.clients.filter((client) => client.representation.clientId !== "realm-management");
    expect(refusal(() => planKeycloak(desiredFixture(), observed)).message).toContain("client realm-management");
  });
});
