import { describe, expect, test } from "bun:test";
import { parseInstallation } from "../../../src/config/schema";
import { CLIENT_SECRET_NAMES, desiredKeycloak, managedRealm } from "../../../src/keycloak/desired";
import type { RealmRepresentation } from "../../../src/keycloak/representations";
import { computeDesired } from "../../../src/model/desired";
import { generateSecret } from "../../../src/secrets/generate";
import { manifestFixture } from "../release/fixture";
import { CLIENT_SECRETS, PASSWORD_LOCATIONS } from "./fixture";

/** The realm settings the installer owns in the realm of its own Keycloak. */
const MANAGED_REALM_SETTINGS: RealmRepresentation = {
  bruteForceProtected: true,
  permanentLockout: false,
  maxTemporaryLockouts: 0,
  bruteForceStrategy: "MULTIPLE",
  failureFactor: 5,
  waitIncrementSeconds: 60,
  maxFailureWaitSeconds: 900,
  maxDeltaTimeSeconds: 43_200,
  quickLoginCheckMilliSeconds: 1000,
  minimumQuickLoginWaitSeconds: 60,
  maxSecondaryAuthFailures: 100,
  passwordPolicy: "length(15) and notUsername and notEmail and passwordHistory(3)",
  eventsEnabled: true,
  eventsExpiration: 7_776_000,
  adminEventsEnabled: true,
  adminEventsDetailsEnabled: true,
  attributes: { adminEventsExpiration: "7776000" },
};

const EXTERNAL = {
  mode: "external",
  external: { baseUrl: "https://auth.example.com", adminUser: "admin", adminPasswordEnv: "CORP_KEYCLOAK_ADMIN_PASSWORD" },
};

function desiredFor(keycloak: Record<string, unknown>) {
  const config = parseInstallation({
    apiVersion: "install.libredb.org/v1",
    kind: "LibreDBInstallation",
    metadata: { name: "acme" },
    mode: "docker",
    endpoints: { hosts: { platform: "platform.example.com", studio: "studio.example.com", auth: "auth.example.com" } },
    platform: { organizationName: "Acme", licenseFile: "/etc/libredb/platform.license" },
    keycloak,
  });
  return desiredKeycloak({
    installation: computeDesired(config, manifestFixture()),
    keycloak: config.keycloak,
    clientSecrets: CLIENT_SECRETS,
    passwordLocations: PASSWORD_LOCATIONS,
  });
}

describe("desiredKeycloak", () => {
  test("derives the role holder, the client scope, both app clients and both accounts from the config", () => {
    const desired = desiredFor({ realm: "corp", firstAdmin: { username: "dba" } });
    expect(desired.realm).toBe("corp");
    expect(desired.roleClient.representation.clientId).toBe("libredb");
    expect(desired.roleClient.roles.map((role) => role.name)).toEqual(["admin", "user"]);
    expect(desired.clientScope.representation.name).toBe("libredb-roles");
    expect(desired.clientScope.scopeMappings).toEqual({ libredb: ["admin", "user"] });
    expect(
      desired.appClients.map((client) => ({
        clientId: client.representation.clientId,
        secret: client.representation.secret,
        redirectUris: client.representation.redirectUris,
        postLogout: client.representation.attributes?.["post.logout.redirect.uris"],
        defaultClientScopes: client.defaultClientScopes,
        scopeMappings: client.scopeMappings,
        serviceAccountRoles: client.serviceAccountRoles,
      })),
    ).toEqual([
      {
        clientId: "libredb-studio",
        secret: CLIENT_SECRETS.studio,
        redirectUris: ["https://studio.example.com/api/auth/oidc/callback"],
        postLogout: "https://studio.example.com/login",
        defaultClientScopes: ["libredb-roles"],
        scopeMappings: {},
        serviceAccountRoles: undefined,
      },
      {
        clientId: "libredb-platform",
        secret: CLIENT_SECRETS.platform,
        redirectUris: ["https://platform.example.com/api/auth/callback/keycloak"],
        postLogout: "https://platform.example.com/login",
        defaultClientScopes: ["libredb-roles"],
        scopeMappings: { "realm-management": ["view-users", "view-clients"] },
        serviceAccountRoles: { "realm-management": ["view-users", "view-clients"] },
      },
    ]);
    expect(desired.users).toEqual([
      {
        username: "dba",
        account: "first-admin",
        passwordLocation: PASSWORD_LOCATIONS.firstAdmin,
        requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"],
        clientRoles: { libredb: ["admin"], "realm-management": [] },
      },
      {
        username: "libredb-user-manager",
        account: "user-manager",
        passwordLocation: PASSWORD_LOCATIONS.userManager,
        requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"],
        clientRoles: { libredb: [], "realm-management": ["manage-users", "view-users", "query-groups", "view-clients"] },
      },
    ]);
  });

  test("leaves an account out when it is not enabled, the default for both accounts of an external Keycloak", () => {
    const accounts = (keycloak: Record<string, unknown>) => desiredFor(keycloak).users.map((user) => user.account);
    expect(accounts({ userManager: { enabled: false } })).toEqual(["first-admin"]);
    expect(accounts({ firstAdmin: { enabled: false } })).toEqual(["user-manager"]);
    expect(accounts(EXTERNAL)).toEqual([]);
    expect(accounts({ ...EXTERNAL, firstAdmin: { enabled: true } })).toEqual(["first-admin"]);
    expect(accounts({ ...EXTERNAL, userManager: { enabled: true } })).toEqual(["user-manager"]);
  });

  test("the realm of a managed Keycloak gets brute force detection, a password policy and saved login and admin events that expire after 90 days, and a reused realm keeps its own settings", () => {
    expect(desiredFor({}).realmSettings).toEqual(MANAGED_REALM_SETTINGS);
    expect(desiredFor(EXTERNAL).realmSettings).toBeUndefined();
    const manual = {
      mode: "external",
      external: {
        baseUrl: "https://auth.example.com",
        provisioning: "manual",
        studioClientSecretEnv: "CORP_STUDIO_CLIENT_SECRET",
        platformClientSecretEnv: "CORP_PLATFORM_CLIENT_SECRET",
      },
    };
    expect(desiredFor(manual).realmSettings).toBeUndefined();
  });

  test("the handover creates the realm with the marker, registration off and the managed settings", () => {
    expect(managedRealm("corp")).toEqual({
      realm: "corp",
      enabled: true,
      registrationAllowed: false,
      ...MANAGED_REALM_SETTINGS,
      attributes: { adminEventsExpiration: "7776000", "libredb.managed": "true" },
    });
  });

  test("the password policy accepts every temporary password the installer generates: it requires no character class, and a generated secret is at least its minimum length", () => {
    const policy = desiredFor({}).realmSettings?.passwordPolicy ?? "";
    const rules = policy.split(" and ");
    // A rule that one random base64url draw can fail, such as a required digit or symbol, is not among them.
    expect(rules.map((rule) => rule.replace(/\(\d+\)$/, ""))).toEqual(["length", "notUsername", "notEmail", "passwordHistory"]);
    const minimum = Number(/^length\((\d+)\)$/.exec(rules[0] ?? "")?.[1]);
    expect(generateSecret().length).toBeGreaterThanOrEqual(minimum);
  });

  test("libredb-platform alone keeps Use refresh tokens on", () => {
    const attributes = desiredFor({}).appClients.map((client) => client.representation.attributes?.["use.refresh.tokens"]);
    expect(attributes).toEqual([undefined, "true"]);
  });

  test("the app client secrets live in the secret store under fixed names", () => {
    expect(CLIENT_SECRET_NAMES).toEqual({
      studio: "keycloak-client-libredb-studio",
      platform: "keycloak-client-libredb-platform",
    });
  });
});
