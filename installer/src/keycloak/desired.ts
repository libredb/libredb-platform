// The Keycloak objects that Platform and Studio rely on, as one configuration asks for them: the role holder `libredb`
// with the client roles `admin` and `user`, the client scope `libredb-roles` that writes them into the flat claim
// `libredb_roles`, the app clients `libredb-studio` and `libredb-platform`, the public client `libredb-mobile` of the
// mobile app while the configuration enables it, and the installation's two accounts: the
// first LibreDB admin, and the user manager that administers users without holding a LibreDB role. In the realm the
// installer creates in its own Keycloak, it also owns the realm's brute force detection, password policy and events.
import type { LibreDBInstallation } from "../config/schema";
import { DEFAULT_QUERY_LOG_RETENTION_DAYS, type ClientUris, type DesiredInstallation } from "../model/desired";
import {
  MANAGED_ATTRIBUTE,
  type ClientRepresentation,
  type ClientRoleNames,
  type ClientScopeRepresentation,
  type ProtocolMapperRepresentation,
  type RealmRepresentation,
  type RoleRepresentation,
} from "./representations";

export const ROLE_CLIENT_ID = "libredb";
export const ROLES_SCOPE = "libredb-roles";
export const ROLES_CLAIM = "libredb_roles";
export const REALM_MANAGEMENT = "realm-management";
export const APP_CLIENT_IDS = { studio: "libredb-studio", platform: "libredb-platform" } as const;

/** The public client of the mobile app, which Studio's OIDC_BEARER_CLIENT_IDS names. */
export const MOBILE_CLIENT_ID = "libredb-mobile";

/**
 * The audience Studio's OIDC_BEARER_AUDIENCE names, which the mobile app's access tokens carry. It is not
 * libredb-studio, the audience of every ID token Studio's web sign-in receives, which Studio refuses as a bearer.
 */
export const STUDIO_API_AUDIENCE = "libredb-studio-api";

/** The audience Platform's PLATFORM_API_AUDIENCE names, which the mobile app's access tokens carry beside Studio's. */
export const PLATFORM_API_AUDIENCE = "libredb-platform-api";

/** The secret store names of the app client secrets, which the app environments read too. */
export const CLIENT_SECRET_NAMES = {
  studio: "keycloak-client-libredb-studio",
  platform: "keycloak-client-libredb-platform",
} as const;

/** The mapper that would replace `sub` with a pairwise identifier, which Studio and Platform key users by. */
export const PAIRWISE_SUB_MAPPER = "oidc-sha256-pairwise-sub-mapper";

/** The realm-management roles Platform's service account reads the directory with. */
export const PLATFORM_DIRECTORY_ROLES = ["view-users", "view-clients"];

/**
 * The realm-management roles of the user manager. They let an account give libredb:admin to anyone, so the first
 * LibreDB admin never gets them.
 */
export const USER_MANAGER_ROLES = ["manage-users", "view-users", "query-groups", "view-clients"];

/** The required actions of an account the installer creates with a temporary password. */
export const FIRST_LOGIN_ACTIONS = ["UPDATE_PASSWORD", "CONFIGURE_TOTP"];

export interface DesiredClient {
  /** The fields and attributes the installer owns; an update merges them over the client Keycloak holds. */
  representation: ClientRepresentation & { clientId: string };
  /** The client roles the installer creates on the client. */
  roles: RoleRepresentation[];
  /** The client scopes that must be default scopes of the client besides the realm's default client scopes. */
  defaultClientScopes: string[] | undefined;
  /** The protocol mappers the client itself must have, by name; Keycloak keeps them in the client's dedicated scope. */
  protocolMappers: ProtocolMapperRepresentation[];
  /** Client roles that must be in the client's own scope mappings. */
  scopeMappings: ClientRoleNames;
  /** The exact client roles of the client's service account, per role client; undefined without a service account. */
  serviceAccountRoles: ClientRoleNames | undefined;
}

export interface DesiredClientScope {
  /** The scope with its one protocol mapper; an update merges the scope's fields and the mapper's config. */
  representation: ClientScopeRepresentation & { protocolMappers: [ClientScopeMapper] };
  /** Client roles that must be in the scope's scope mappings. */
  scopeMappings: ClientRoleNames;
}

type ClientScopeMapper = NonNullable<ClientScopeRepresentation["protocolMappers"]>[number];

export type Account = "first-admin" | "user-manager";

export interface DesiredUser {
  username: string;
  account: Account;
  /** Where the temporary password is kept, which the plan names. */
  passwordLocation: string;
  requiredActions: string[];
  /** The exact client roles of the account for each role client the installer manages. */
  clientRoles: ClientRoleNames;
}

export interface DesiredKeycloak {
  realm: string;
  /**
   * The realm settings the installer owns, which an update merges over the realm Keycloak holds: only for the realm it
   * created in its own Keycloak, and undefined for a reused realm, whose settings stay the site's.
   */
  realmSettings: RealmRepresentation | undefined;
  roleClient: DesiredClient;
  clientScope: DesiredClientScope;
  appClients: DesiredClient[];
  users: DesiredUser[];
}

export interface KeycloakDesiredInputs {
  /**
   * The realm, the redirect and post-logout URIs of the app clients and of the mobile app's client when it is enabled,
   * and whether the installer runs Keycloak.
   */
  installation: Pick<DesiredInstallation, "realm" | "clients"> & { keycloak: Pick<DesiredInstallation["keycloak"], "managed"> };
  keycloak: Pick<LibreDBInstallation["keycloak"], "firstAdmin" | "userManager">;
  /**
   * The secrets of `libredb-studio` and `libredb-platform` from the installer's secret store, or undefined for the
   * export and the check of a realm the site configures, where Keycloak generates each secret.
   */
  clientSecrets: { studio: string; platform: string } | undefined;
  /** Where each account's temporary password is kept. */
  passwordLocations: { firstAdmin: string; userManager: string };
}

// Grants the clients never use: the device flow, CIBA and standard token exchange.
const OTHER_GRANTS_OFF = {
  "oauth2.device.authorization.grant.enabled": "false",
  "oidc.ciba.grant.enabled": "false",
  "standard.token.exchange.enabled": "false",
};

function roleClient(): DesiredClient {
  const role = (name: string, description: string): RoleRepresentation => ({
    name,
    description,
    attributes: { [MANAGED_ATTRIBUTE]: ["true"] },
  });
  return {
    representation: {
      clientId: ROLE_CLIENT_ID,
      name: "LibreDB roles",
      description: "Holds the LibreDB client roles admin and user. Every flow is disabled and no secret is used.",
      protocol: "openid-connect",
      enabled: true,
      publicClient: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      attributes: { [MANAGED_ATTRIBUTE]: "true", ...OTHER_GRANTS_OFF },
    },
    roles: [role("admin", "LibreDB administrator"), role("user", "LibreDB user")],
    defaultClientScopes: undefined,
    protocolMappers: [],
    scopeMappings: {},
    serviceAccountRoles: undefined,
  };
}

function clientScope(): DesiredClientScope {
  return {
    representation: {
      name: ROLES_SCOPE,
      description: `The LibreDB client roles in the claim ${ROLES_CLAIM}`,
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "false", "display.on.consent.screen": "false", [MANAGED_ATTRIBUTE]: "true" },
      protocolMappers: [
        {
          name: "libredb roles",
          protocol: "openid-connect",
          protocolMapper: "oidc-usermodel-client-role-mapper",
          consentRequired: false,
          config: {
            "usermodel.clientRoleMapping.clientId": ROLE_CLIENT_ID,
            "claim.name": ROLES_CLAIM,
            multivalued: "true",
            "jsonType.label": "String",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true",
            "introspection.token.claim": "true",
          },
        },
      ],
    },
    // Puts both roles in the token's scope when Full Scope Allowed is off on an app client.
    scopeMappings: { [ROLE_CLIENT_ID]: ["admin", "user"] },
  };
}

// Platform keeps its Keycloak session alive with the refresh token and refuses a sign-in without one, so
// Use refresh tokens stays on for libredb-platform even where a realm's administrators turn it off for other clients.
const REFRESH_TOKENS_ON = { "use.refresh.tokens": "true" };

function appClient(
  clientId: string,
  name: string,
  secret: string | undefined,
  uris: ClientUris,
  serviceAccount: boolean,
  attributes: Record<string, string> = {},
): DesiredClient {
  return {
    representation: {
      clientId,
      name,
      protocol: "openid-connect",
      enabled: true,
      publicClient: false,
      clientAuthenticatorType: "client-secret",
      ...(secret === undefined ? {} : { secret }),
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: serviceAccount,
      redirectUris: [uris.redirectUri],
      attributes: {
        [MANAGED_ATTRIBUTE]: "true",
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": uris.postLogoutRedirectUri,
        ...OTHER_GRANTS_OFF,
        ...attributes,
      },
    },
    roles: [],
    defaultClientScopes: [ROLES_SCOPE],
    protocolMappers: [],
    // Keycloak lets a service account use a role only when the role is in its client's scope, so these mappings keep
    // the directory readable when Full Scope Allowed is off.
    scopeMappings: serviceAccount ? { [REALM_MANAGEMENT]: [...PLATFORM_DIRECTORY_ROLES] } : {},
    serviceAccountRoles: serviceAccount ? { [REALM_MANAGEMENT]: [...PLATFORM_DIRECTORY_ROLES] } : undefined,
  };
}

// The scopes that put sub, preferred_username and email into the mobile app's access token, which Studio's bearer
// channel needs besides the roles; a client Keycloak creates gets them from the realm's defaults, and an existing
// client gets them back.
const MOBILE_IDENTITY_SCOPES = ["basic", "profile", "email"];

/** An audience mapper that adds one custom audience to the access token alone, since Keycloak's takes one per mapper. */
function audienceMapper(name: string, audience: string): ProtocolMapperRepresentation {
  return {
    name,
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    consentRequired: false,
    config: {
      "included.custom.audience": audience,
      "id.token.claim": "false",
      "access.token.claim": "true",
      "introspection.token.claim": "true",
    },
  };
}

/**
 * The mobile app's client: public, because an app on a phone cannot keep a secret, signing in with the standard flow
 * and PKCE S256 only, with the roles scope and audience mappers that name the audiences Studio's bearer channel and
 * Platform's bearer API check in the access token alone.
 */
function mobileClient(uris: ClientUris): DesiredClient {
  return {
    representation: {
      clientId: MOBILE_CLIENT_ID,
      name: "LibreDB Mobile",
      protocol: "openid-connect",
      enabled: true,
      publicClient: true,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      redirectUris: [uris.redirectUri],
      attributes: {
        [MANAGED_ATTRIBUTE]: "true",
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": uris.postLogoutRedirectUri,
        ...OTHER_GRANTS_OFF,
      },
    },
    roles: [],
    defaultClientScopes: [...MOBILE_IDENTITY_SCOPES, ROLES_SCOPE],
    protocolMappers: [
      audienceMapper("libredb studio api audience", STUDIO_API_AUDIENCE),
      audienceMapper("libredb platform api audience", PLATFORM_API_AUDIENCE),
    ],
    scopeMappings: {},
    serviceAccountRoles: undefined,
  };
}

function account(username: string, kind: Account, passwordLocation: string, clientRoles: ClientRoleNames): DesiredUser {
  return { username, account: kind, passwordLocation, requiredActions: [...FIRST_LOGIN_ACTIONS], clientRoles };
}

// Saved events expire after the default retention of Platform's query log, so the sign-ins and the role changes behind
// a logged query stay as long as the query, and Keycloak's database stays bounded.
const EVENTS_EXPIRATION_SECONDS = DEFAULT_QUERY_LOG_RETENTION_DAYS * 24 * 60 * 60;

/** The settings the installer owns in the realm of its own Keycloak, all of which a new Keycloak realm lacks. */
function managedRealmSettings(): RealmRepresentation {
  return {
    // Brute force detection in the mode Keycloak's documentation calls Lockout temporarily: after 5 failed sign-ins a
    // user waits 1 minute, every further 5 add a minute up to 15 minutes, and the count resets 12 hours after the last
    // failure, which are Keycloak's defaults except 5 failures instead of 30. A permanent lockout would let anyone who
    // knows a username, such as the default libredb-admin, disable that account, the downside the documentation names;
    // only 100 wrong OTP codes after a correct password lock an account for good, the value it calls reasonable.
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
    // At least 15 characters, the minimum NIST SP 800-63B-4 sets for a password that is the only factor, as for a
    // libredb:user account without OTP; neither the username nor the email; and none of the current or 2 previous
    // passwords, Keycloak's default history of 3, so the temporary password kept in a file never becomes an account's
    // own. No character class is required: NIST rules them out, and a random base64url temporary password of the
    // installer may lack a digit or a symbol. Hashing stays Keycloak's default.
    passwordPolicy: "length(15) and notUsername and notEmail and passwordHistory(3)",
    // Login and admin events are saved, the admin events with the representation of each change, which alone names the
    // role a mapping grants and from which Keycloak strips passwords and client secrets.
    eventsEnabled: true,
    eventsExpiration: EVENTS_EXPIRATION_SECONDS,
    adminEventsEnabled: true,
    adminEventsDetailsEnabled: true,
    attributes: { adminEventsExpiration: String(EVENTS_EXPIRATION_SECONDS) },
  };
}

/** The realm the handover creates in the installer's own Keycloak: marked, with registration off and its settings. */
export function managedRealm(realm: string): RealmRepresentation {
  const settings = managedRealmSettings();
  return {
    realm,
    enabled: true,
    registrationAllowed: false,
    ...settings,
    attributes: { ...settings.attributes, [MANAGED_ATTRIBUTE]: "true" },
  };
}

/**
 * Derives the Keycloak objects and the installation's accounts: each account only while it is enabled, which by
 * default holds for a managed Keycloak and not for a reused realm, whose users the customer's identity team manages.
 * The realm settings are derived only for a managed Keycloak, because a reused realm's settings stay the site's.
 */
export function desiredKeycloak(inputs: KeycloakDesiredInputs): DesiredKeycloak {
  const { installation, keycloak, clientSecrets, passwordLocations } = inputs;
  const users: DesiredUser[] = [];
  if (keycloak.firstAdmin.enabled) {
    users.push(
      account(keycloak.firstAdmin.username, "first-admin", passwordLocations.firstAdmin, {
        [ROLE_CLIENT_ID]: ["admin"],
        [REALM_MANAGEMENT]: [],
      }),
    );
  }
  if (keycloak.userManager.enabled) {
    users.push(
      account(keycloak.userManager.username, "user-manager", passwordLocations.userManager, {
        [ROLE_CLIENT_ID]: [],
        [REALM_MANAGEMENT]: [...USER_MANAGER_ROLES],
      }),
    );
  }
  return {
    realm: installation.realm,
    realmSettings: installation.keycloak.managed ? managedRealmSettings() : undefined,
    roleClient: roleClient(),
    clientScope: clientScope(),
    appClients: [
      appClient(APP_CLIENT_IDS.studio, "LibreDB Studio", clientSecrets?.studio, installation.clients.studio, false),
      appClient(
        APP_CLIENT_IDS.platform,
        "LibreDB Platform",
        clientSecrets?.platform,
        installation.clients.platform,
        true,
        REFRESH_TOKENS_ON,
      ),
      ...(installation.clients.mobile === undefined ? [] : [mobileClient(installation.clients.mobile)]),
    ],
    users,
  };
}
