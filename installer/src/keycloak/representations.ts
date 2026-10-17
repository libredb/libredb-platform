// The Keycloak Admin REST representations the realm converge reads and writes, the observation it plans
// against, and the marker every object the installer creates carries. A representation keeps the fields Keycloak
// returns beyond the typed ones, so an update can send them back unchanged.

/** The attribute every Keycloak object the installer creates carries, with the value "true". */
export const MANAGED_ATTRIBUTE = "libredb.managed";

/** A realm, with the settings the installer owns typed; Keycloak keeps realm attributes as strings. */
export interface RealmRepresentation {
  id?: string;
  realm?: string;
  enabled?: boolean;
  registrationAllowed?: boolean;
  bruteForceProtected?: boolean;
  permanentLockout?: boolean;
  maxTemporaryLockouts?: number;
  bruteForceStrategy?: "LINEAR" | "MULTIPLE";
  failureFactor?: number;
  waitIncrementSeconds?: number;
  maxFailureWaitSeconds?: number;
  maxDeltaTimeSeconds?: number;
  quickLoginCheckMilliSeconds?: number;
  minimumQuickLoginWaitSeconds?: number;
  maxSecondaryAuthFailures?: number;
  passwordPolicy?: string;
  eventsEnabled?: boolean;
  eventsExpiration?: number;
  adminEventsEnabled?: boolean;
  adminEventsDetailsEnabled?: boolean;
  attributes?: Record<string, string>;
  [field: string]: unknown;
}

export interface ProtocolMapperRepresentation {
  id?: string;
  name: string;
  protocol: string;
  protocolMapper: string;
  consentRequired?: boolean;
  config: Record<string, string>;
  [field: string]: unknown;
}

export interface ClientRepresentation {
  id?: string;
  clientId: string;
  name?: string;
  description?: string;
  protocol?: string;
  enabled?: boolean;
  publicClient?: boolean;
  clientAuthenticatorType?: string;
  secret?: string;
  standardFlowEnabled?: boolean;
  implicitFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  serviceAccountsEnabled?: boolean;
  redirectUris?: string[];
  attributes?: Record<string, string>;
  protocolMappers?: ProtocolMapperRepresentation[];
  defaultClientScopes?: string[];
  optionalClientScopes?: string[];
  [field: string]: unknown;
}

export interface ClientScopeRepresentation {
  id?: string;
  name: string;
  description?: string;
  protocol: string;
  attributes?: Record<string, string>;
  protocolMappers?: ProtocolMapperRepresentation[];
  [field: string]: unknown;
}

/** A role; Keycloak keeps role attributes as lists of strings. */
export interface RoleRepresentation {
  id?: string;
  name: string;
  description?: string;
  attributes?: Record<string, string[]>;
  [field: string]: unknown;
}

export interface CredentialRepresentation {
  type: string;
  value: string;
  temporary: boolean;
}

export interface UserRepresentation {
  id?: string;
  username: string;
  enabled?: boolean;
  requiredActions?: string[];
  credentials?: CredentialRepresentation[];
  [field: string]: unknown;
}

/** The id and name of a role, the form Keycloak takes in a role mapping or a scope mapping request. */
export interface RoleRef {
  id: string;
  name: string;
}

/** Role names by the clientId of the client that holds them, such as `{ "realm-management": ["view-users"] }`. */
export type ClientRoleNames = Record<string, string[]>;

/** A client of the realm as the converge reads it. */
export interface ObservedClient {
  /** The representation GET /clients returns, with its id, attributes, protocol mappers and secret. */
  representation: ClientRepresentation & { id: string };
  /** The client's roles with their attributes. */
  roles: RoleRepresentation[];
  /** The client roles of other clients in this client's own scope mappings. */
  scopeMappings: ClientRoleNames;
  /** The service account user and its client role mappings, when the client has service accounts on. */
  serviceAccount?: { id: string; clientRoles: ClientRoleNames };
}

/** A client scope of the realm as the converge reads it. */
export interface ObservedClientScope {
  /** The representation GET /client-scopes returns, with its id and protocol mappers. */
  representation: ClientScopeRepresentation & { id: string };
  /** The client roles in the scope's scope mappings. */
  scopeMappings: ClientRoleNames;
}

/** One of the installation's accounts that exists in the realm. */
export interface ObservedUser {
  id: string;
  username: string;
  /** The user's direct client role mappings. */
  clientRoles: ClientRoleNames;
}

/** What the converge reads from the realm, and from the installer state, before it plans. */
export interface ObservedKeycloak {
  realm: string;
  /**
   * The realm as GET /admin/realms/<realm> returns it, read only when the installer owns the realm's settings, which it
   * never does in a reused realm.
   */
  realmRepresentation?: RealmRepresentation;
  /** The names of the realm's default client scopes of protocol openid-connect. */
  defaultClientScopes: string[];
  /** Every client scope of the realm. */
  clientScopes: ObservedClientScope[];
  /** The clients the converge manages that exist, and realm-management. */
  clients: ObservedClient[];
  /** The installation's accounts that exist. */
  users: ObservedUser[];
  /**
   * The usernames the installer state records as created by this installation. Keycloak 26 drops user attributes
   * that its user profile does not declare, so a user's marker is this record instead of an attribute.
   */
  createdUsers: string[];
}

/** Whether a client, a client scope or a realm carries the marker. */
export function hasMarker(attributes: Record<string, string> | undefined): boolean {
  return attributes?.[MANAGED_ATTRIBUTE] === "true";
}

/** Whether a role carries the marker, which Keycloak keeps as a one-element list. */
export function roleHasMarker(role: RoleRepresentation): boolean {
  const values = role.attributes?.[MANAGED_ATTRIBUTE];
  return values !== undefined && values.length === 1 && values[0] === "true";
}
