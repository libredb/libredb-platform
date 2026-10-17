// Plans the Admin REST converge of the keycloak-configure step: from the desired objects and what the realm holds,
// the create, update and delete actions that make the realm match, in an order where every action finds the objects it
// refers to. It is pure, so the same desired objects and observation always give the same plan, and a converged realm
// gives none. An action holds no secret in its summary; a client update carries the stored client secret in its body.
import { ExitCode } from "../cli/exit-codes";
import type { Action } from "../engine/step";
import {
  PAIRWISE_SUB_MAPPER,
  type DesiredClient,
  type DesiredClientScope,
  type DesiredKeycloak,
  type DesiredUser,
} from "./desired";
import {
  hasMarker,
  MANAGED_ATTRIBUTE,
  roleHasMarker,
  type ClientRepresentation,
  type ClientRoleNames,
  type ClientScopeRepresentation,
  type ObservedClient,
  type ObservedClientScope,
  type ObservedKeycloak,
  type ProtocolMapperRepresentation,
  type RealmRepresentation,
  type RoleRepresentation,
  type UserRepresentation,
} from "./representations";

/** Whose scope mappings an action changes: a client scope's, or a client's own. */
export type ScopeTarget = { type: "client-scope"; name: string } | { type: "client"; clientId: string };

/** Whose role mappings an action changes: a client's service account, or a user. */
export type RoleSubject = { type: "service-account"; clientId: string } | { type: "user"; username: string };

export type KeycloakAction = Action &
  (
    | { kind: "update-realm"; representation: RealmRepresentation }
    | { kind: "create-client"; clientId: string; representation: ClientRepresentation }
    | { kind: "update-client"; clientId: string; id: string; representation: ClientRepresentation }
    | { kind: "create-role"; clientId: string; role: RoleRepresentation }
    | { kind: "create-client-scope"; name: string; representation: ClientScopeRepresentation }
    | { kind: "update-client-scope"; name: string; id: string; representation: ClientScopeRepresentation }
    | { kind: "create-mapper"; scope: string; mapper: ProtocolMapperRepresentation }
    | { kind: "update-mapper"; scope: string; id: string; mapper: ProtocolMapperRepresentation }
    | { kind: "delete-mapper"; scope: string; id: string; name: string }
    | { kind: "add-scope-roles"; target: ScopeTarget; roleClientId: string; roles: string[] }
    | { kind: "remove-optional-scope"; clientId: string; scope: string }
    | { kind: "add-default-scope"; clientId: string; scope: string }
    | { kind: "map-roles"; subject: RoleSubject; roleClientId: string; roles: string[] }
    | { kind: "unmap-roles"; subject: RoleSubject; roleClientId: string; roles: string[] }
    | { kind: "create-user"; username: string; representation: UserRepresentation }
  );

/** A realm the converge must not change. Its message names the objects and never holds a secret. */
export class KeycloakConvergeError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "KeycloakConvergeError";
    this.exitCode = exitCode;
  }
}

/** "a", "a and b", "a, b and c". */
function list(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const qualified = (roleClientId: string, roles: readonly string[]) => roles.map((role) => `${roleClientId}:${role}`);

const clientOf = (observed: ObservedKeycloak, clientId: string): ObservedClient | undefined =>
  observed.clients.find((client) => client.representation.clientId === clientId);

const scopeOf = (observed: ObservedKeycloak, name: string): ObservedClientScope | undefined =>
  observed.clientScopes.find((scope) => scope.representation.name === name);

/** The objects of the installer's names that it did not create: unmarked clients, scopes and roles, unrecorded users. */
function foreignObjects(desired: DesiredKeycloak, observed: ObservedKeycloak): string[] {
  const found: string[] = [];
  for (const client of [desired.roleClient, ...desired.appClients]) {
    const clientId = client.representation.clientId;
    const live = clientOf(observed, clientId);
    if (live === undefined) continue;
    if (!hasMarker(live.representation.attributes)) {
      found.push(`client ${clientId}`);
      continue;
    }
    for (const role of client.roles) {
      const liveRole = live.roles.find((candidate) => candidate.name === role.name);
      if (liveRole !== undefined && !roleHasMarker(liveRole)) found.push(`role ${clientId}:${role.name}`);
    }
  }
  const scope = scopeOf(observed, desired.clientScope.representation.name);
  if (scope !== undefined && !hasMarker(scope.representation.attributes)) found.push(`client scope ${scope.representation.name}`);
  for (const user of desired.users) {
    const exists = observed.users.some((candidate) => candidate.username === user.username);
    if (exists && !observed.createdUsers.includes(user.username)) found.push(`user ${user.username}`);
  }
  return found;
}

/** Why a pairwise subject mapper on an app client is refused. */
export const PAIRWISE_CONSEQUENCE = "which would change the sub claim that Studio and Platform key every user by";

/** The pairwise subject mappers among the protocol mappers of an app client, each named with the client. */
export function pairwiseFindings(
  clientId: string,
  mappers: readonly Pick<ProtocolMapperRepresentation, "name" | "protocolMapper">[],
): string[] {
  return mappers
    .filter((mapper) => mapper.protocolMapper === PAIRWISE_SUB_MAPPER)
    .map((mapper) => `client ${clientId} has the mapper ${mapper.name} of type ${PAIRWISE_SUB_MAPPER}`);
}

/** The pairwise subject mappers on the app clients, each named with its client. */
function pairwiseMappers(desired: DesiredKeycloak, observed: ObservedKeycloak): string[] {
  return desired.appClients.flatMap((client) => {
    const clientId = client.representation.clientId;
    return pairwiseFindings(clientId, clientOf(observed, clientId)?.representation.protocolMappers ?? []);
  });
}

/** The roles of other clients that the plan maps, such as realm-management's, which must exist in the realm. */
function missingRoles(desired: DesiredKeycloak, observed: ObservedKeycloak): string[] {
  const referenced: ClientRoleNames[] = [
    ...desired.appClients.flatMap((client) => [client.scopeMappings, client.serviceAccountRoles ?? {}]),
    ...desired.users.map((user) => user.clientRoles),
  ];
  const missing = new Set<string>();
  for (const roles of referenced) {
    for (const [roleClientId, names] of Object.entries(roles)) {
      if (roleClientId === desired.roleClient.representation.clientId || names.length === 0) continue;
      const live = clientOf(observed, roleClientId);
      if (live === undefined) missing.add(`client ${roleClientId}`);
      for (const name of names) {
        if (live !== undefined && !live.roles.some((role) => role.name === name)) missing.add(`${roleClientId} role ${name}`);
      }
    }
  }
  return [...missing];
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    const a = [...left].sort();
    const b = [...right].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return left === right;
}

type WithAttributes = { attributes?: Record<string, string>; [field: string]: unknown };

/** The owned fields whose live value differs, the top-level fields first and then the attributes by name. */
function driftedFields(owned: WithAttributes, live: WithAttributes): string[] {
  const fields = Object.keys(owned).filter((key) => key !== "attributes" && !sameValue(owned[key], live[key]));
  const attributes = Object.entries(owned.attributes ?? {})
    .filter(([key, value]) => live.attributes?.[key] !== value)
    .map(([key]) => key);
  return [...fields, ...attributes];
}

// Sub-resources with endpoints of their own. An update leaves them out, so Keycloak keeps them: a client PUT would
// apply the protocol mappers it carries.
const SUB_RESOURCES = ["protocolMappers", "defaultClientScopes", "optionalClientScopes"];

/** The live representation with the owned fields and attributes put over it, and without its sub-resources. */
function merged<T extends WithAttributes>(live: T, owned: WithAttributes): T {
  const kept = Object.fromEntries(Object.entries(live).filter(([key]) => !SUB_RESOURCES.includes(key)));
  return { ...kept, ...owned, attributes: { ...live.attributes, ...owned.attributes } } as T;
}

interface RealmSettings {
  owned: RealmRepresentation;
  live: RealmRepresentation;
}

/** The realm settings the installer owns with the realm as Keycloak holds it, or undefined in a reused realm. */
function realmSettings(desired: DesiredKeycloak, observed: ObservedKeycloak): RealmSettings | undefined {
  const owned = desired.realmSettings;
  if (owned === undefined) return undefined;
  const live = observed.realmRepresentation;
  if (live === undefined) throw new Error(`the observation of realm ${observed.realm} holds no realm representation`);
  return { owned, live };
}

function realmActions(realm: string, settings: RealmSettings | undefined): KeycloakAction[] {
  if (settings === undefined) return [];
  const drift = driftedFields(settings.owned, settings.live);
  if (drift.length === 0) return [];
  const representation = merged(settings.live, settings.owned);
  return [{ kind: "update-realm", representation, summary: `update realm ${realm} (${drift.join(", ")})` }];
}

function roleMappingActions(subject: RoleSubject, wanted: ClientRoleNames, held: ClientRoleNames): KeycloakAction[] {
  const who = subject.type === "user" ? `user ${subject.username}` : `the service account of client ${subject.clientId}`;
  const actions: KeycloakAction[] = [];
  for (const [roleClientId, roles] of Object.entries(wanted)) {
    const current = held[roleClientId] ?? [];
    const missing = roles.filter((role) => !current.includes(role));
    const extra = current.filter((role) => !roles.includes(role));
    if (missing.length > 0) {
      const summary = `grant ${list(qualified(roleClientId, missing))} to ${who}`;
      actions.push({ kind: "map-roles", subject, roleClientId, roles: missing, summary });
    }
    if (extra.length > 0) {
      const summary = `revoke ${list(qualified(roleClientId, extra))} from ${who}`;
      actions.push({ kind: "unmap-roles", subject, roleClientId, roles: extra, summary });
    }
  }
  return actions;
}

function scopeMappingActions(target: ScopeTarget, wanted: ClientRoleNames, held: ClientRoleNames): KeycloakAction[] {
  const into = target.type === "client" ? `the scope of client ${target.clientId}` : `client scope ${target.name}`;
  return Object.entries(wanted).flatMap(([roleClientId, roles]): KeycloakAction[] => {
    const missing = roles.filter((role) => !(held[roleClientId] ?? []).includes(role));
    if (missing.length === 0) return [];
    const summary = `map the roles ${list(qualified(roleClientId, missing))} into ${into}`;
    return [{ kind: "add-scope-roles", target, roleClientId, roles: missing, summary }];
  });
}

function defaultScopeActions(
  clientId: string,
  extra: readonly string[],
  live: ObservedClient | undefined,
  realmDefaults: readonly string[],
): KeycloakAction[] {
  // Keycloak gives a client it creates the realm's default client scopes, so a new client needs only the extra ones.
  const wanted = live === undefined ? extra : [...new Set([...realmDefaults, ...extra])];
  const defaults = live?.representation.defaultClientScopes ?? [];
  const optional = live?.representation.optionalClientScopes ?? [];
  const actions: KeycloakAction[] = [];
  for (const scope of wanted.filter((name) => !defaults.includes(name))) {
    // Keycloak ignores a default scope that the client already has as an optional one.
    if (optional.includes(scope)) {
      const summary = `remove client scope ${scope} from the optional scopes of client ${clientId}`;
      actions.push({ kind: "remove-optional-scope", clientId, scope, summary });
    }
    actions.push({ kind: "add-default-scope", clientId, scope, summary: `add default client scope ${scope} to client ${clientId}` });
  }
  return actions;
}

function clientActions(desired: DesiredClient, observed: ObservedKeycloak): KeycloakAction[] {
  const clientId = desired.representation.clientId;
  const live = clientOf(observed, clientId);
  const actions: KeycloakAction[] = [];
  if (live === undefined) {
    actions.push({ kind: "create-client", clientId, representation: desired.representation, summary: `create client ${clientId}` });
  } else {
    const drift = driftedFields(desired.representation, live.representation);
    if (drift.length > 0) {
      actions.push({
        kind: "update-client",
        clientId,
        id: live.representation.id,
        representation: merged(live.representation, desired.representation),
        summary: `update client ${clientId} (${drift.join(", ")})`,
      });
    }
  }
  for (const role of desired.roles.filter((wanted) => !live?.roles.some((held) => held.name === wanted.name))) {
    actions.push({ kind: "create-role", clientId, role, summary: `create role ${role.name} on client ${clientId}` });
  }
  if (desired.defaultClientScopes !== undefined) {
    actions.push(...defaultScopeActions(clientId, desired.defaultClientScopes, live, observed.defaultClientScopes));
  }
  actions.push(...scopeMappingActions({ type: "client", clientId }, desired.scopeMappings, live?.scopeMappings ?? {}));
  if (desired.serviceAccountRoles !== undefined) {
    const held = live?.serviceAccount?.clientRoles ?? {};
    actions.push(...roleMappingActions({ type: "service-account", clientId }, desired.serviceAccountRoles, held));
  }
  return actions;
}

function mapperId(scope: string, mapper: ProtocolMapperRepresentation): string {
  if (mapper.id === undefined) {
    throw new Error(`Keycloak returned the protocol mapper ${mapper.name} of client scope ${scope} without an id`);
  }
  return mapper.id;
}

function mapperActions(
  scope: string,
  wanted: readonly ProtocolMapperRepresentation[],
  live: readonly ProtocolMapperRepresentation[],
): KeycloakAction[] {
  const create = (mapper: ProtocolMapperRepresentation): KeycloakAction => ({
    kind: "create-mapper",
    scope,
    mapper,
    summary: `create protocol mapper ${mapper.name} in client scope ${scope}`,
  });
  const remove = (mapper: ProtocolMapperRepresentation): KeycloakAction => ({
    kind: "delete-mapper",
    scope,
    id: mapperId(scope, mapper),
    name: mapper.name,
    summary: `delete protocol mapper ${mapper.name} from client scope ${scope}`,
  });
  const actions: KeycloakAction[] = [];
  for (const mapper of wanted) {
    const found = live.find((candidate) => candidate.name === mapper.name);
    if (found === undefined) {
      actions.push(create(mapper));
    } else if (found.protocolMapper !== mapper.protocolMapper || found.protocol !== mapper.protocol) {
      actions.push(remove(found), create(mapper));
    } else {
      const drift = Object.entries(mapper.config)
        .filter(([key, value]) => found.config[key] !== value)
        .map(([key]) => key);
      if (drift.length > 0) {
        const id = mapperId(scope, found);
        actions.push({
          kind: "update-mapper",
          scope,
          id,
          mapper: { ...found, ...mapper, id, config: { ...found.config, ...mapper.config } },
          summary: `update protocol mapper ${mapper.name} in client scope ${scope} (${drift.join(", ")})`,
        });
      }
    }
  }
  // The scope carries exactly the installer's mappers, so no other claim reaches both apps through it.
  for (const other of live.filter((candidate) => !wanted.some((mapper) => mapper.name === candidate.name))) {
    actions.push(remove(other));
  }
  return actions;
}

function clientScopeActions(desired: DesiredClientScope, observed: ObservedKeycloak): KeycloakAction[] {
  const name = desired.representation.name;
  const live = scopeOf(observed, name);
  const actions: KeycloakAction[] = [];
  if (live === undefined) {
    actions.push({ kind: "create-client-scope", name, representation: desired.representation, summary: `create client scope ${name}` });
  } else {
    const { protocolMappers, ...owned } = desired.representation;
    const drift = driftedFields(owned, live.representation);
    if (drift.length > 0) {
      actions.push({
        kind: "update-client-scope",
        name,
        id: live.representation.id,
        representation: merged(live.representation, owned),
        summary: `update client scope ${name} (${drift.join(", ")})`,
      });
    }
    actions.push(...mapperActions(name, protocolMappers, live.representation.protocolMappers ?? []));
  }
  actions.push(...scopeMappingActions({ type: "client-scope", name }, desired.scopeMappings, live?.scopeMappings ?? {}));
  return actions;
}

function userActions(desired: DesiredUser, observed: ObservedKeycloak): KeycloakAction[] {
  const { username } = desired;
  const subject: RoleSubject = { type: "user", username };
  const live = observed.users.find((candidate) => candidate.username === username);
  if (live !== undefined) return roleMappingActions(subject, desired.clientRoles, live.clientRoles);
  // An account is created once: one the state records was deleted after its creation, and it stays deleted.
  if (observed.createdUsers.includes(username)) return [];
  return [
    {
      kind: "create-user",
      username,
      representation: { username, enabled: true, requiredActions: [...desired.requiredActions] },
      summary:
        `create user ${username} with a temporary password in ${desired.passwordLocation} ` +
        `and the required actions ${list(desired.requiredActions)}`,
    },
    ...roleMappingActions(subject, desired.clientRoles, {}),
  ];
}

/**
 * Plans the actions that converge the realm on the desired objects. Refuses with exit 6 an object of the installer's
 * names that it did not create, and a realm whose settings it owns without the marker, and with exit 3 a pairwise
 * subject mapper on an app client or a realm that lacks a role the plan maps.
 */
export function planKeycloak(desired: DesiredKeycloak, observed: ObservedKeycloak): KeycloakAction[] {
  const settings = realmSettings(desired, observed);
  if (settings !== undefined && !hasMarker(settings.live.attributes)) {
    throw new KeycloakConvergeError(
      `realm ${observed.realm} exists without the attribute ${MANAGED_ATTRIBUTE}=true that the installer gives the realm ` +
        "it creates, so it does not change the realm's settings; if this installation created the realm, set the " +
        "attribute again, and otherwise install with keycloak.mode external",
      ExitCode.UnsafeChangeRefused,
    );
  }
  const foreign = foreignObjects(desired, observed);
  if (foreign.length > 0) {
    throw new KeycloakConvergeError(
      `realm ${observed.realm} holds ${list(foreign)}, which the installer did not create, so it does not take them ` +
        `over: a client, client scope or role it creates carries the attribute ${MANAGED_ATTRIBUTE}=true, and a user ` +
        "it creates is recorded in the installer state. Remove or rename them, then run the installer again",
      ExitCode.UnsafeChangeRefused,
    );
  }
  const pairwise = pairwiseMappers(desired, observed);
  if (pairwise.length > 0) {
    throw new KeycloakConvergeError(
      `${list(pairwise)}, ${PAIRWISE_CONSEQUENCE}; remove the mapper, then run the installer again`,
      ExitCode.PreflightFailed,
    );
  }
  const missing = missingRoles(desired, observed);
  if (missing.length > 0) {
    throw new KeycloakConvergeError(
      `realm ${observed.realm} lacks ${list(missing)}, which every Keycloak 26 realm has and the installer's accounts need`,
      ExitCode.PreflightFailed,
    );
  }
  // The realm comes first, so its password policy holds when the accounts get their temporary passwords.
  return [
    ...realmActions(observed.realm, settings),
    ...clientActions(desired.roleClient, observed),
    ...clientScopeActions(desired.clientScope, observed),
    ...desired.appClients.flatMap((client) => clientActions(client, observed)),
    ...desired.users.flatMap((user) => userActions(user, observed)),
  ];
}
