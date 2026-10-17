// Maps each converge action to one Admin REST request of the realm. The ids of the objects a request names come from
// a request context, which knows the objects the realm held when the plan was made and those the converge created
// since, and the temporary password of an account comes from it too, so a plan never holds a password.
import type { KeycloakAction } from "./planner";
import type { RoleRef } from "./representations";

export interface AdminRequest {
  method: "POST" | "PUT" | "DELETE";
  /** The Admin API path, starting with `/admin/realms/<realm>`. */
  path: string;
  body?: unknown;
  /** The statuses that mean the request did what it should. */
  expected: readonly number[];
}

/** Resolves the objects a request names to their Keycloak ids. */
export interface RequestContext {
  /** The id of the client with this clientId. */
  clientUuid(clientId: string): Promise<string>;
  clientScopeId(name: string): Promise<string>;
  /** The id and name of a client role, the form a role or scope mapping request takes. */
  role(clientId: string, name: string): Promise<RoleRef>;
  /** The id of the service account user of a client. */
  serviceAccountUserId(clientId: string): Promise<string>;
  userId(username: string): Promise<string>;
  /** The temporary password of an account the converge creates, which the caller stored before the create. */
  temporaryPassword(username: string): Promise<string>;
}

const segment = encodeURIComponent;

export async function adminRequest(realm: string, action: KeycloakAction, context: RequestContext): Promise<AdminRequest> {
  const base = `/admin/realms/${segment(realm)}`;
  const client = async (clientId: string) => `${base}/clients/${segment(await context.clientUuid(clientId))}`;
  const scope = async (name: string) => `${base}/client-scopes/${segment(await context.clientScopeId(name))}`;
  const roles = (roleClientId: string, names: readonly string[]) =>
    Promise.all(names.map((name) => context.role(roleClientId, name)));
  switch (action.kind) {
    case "update-realm":
      return { method: "PUT", path: base, body: action.representation, expected: [204] };
    case "create-client":
      return { method: "POST", path: `${base}/clients`, body: action.representation, expected: [201] };
    case "update-client":
      return { method: "PUT", path: `${base}/clients/${segment(action.id)}`, body: action.representation, expected: [204] };
    case "create-role":
      return { method: "POST", path: `${await client(action.clientId)}/roles`, body: action.role, expected: [201] };
    case "create-client-scope":
      return { method: "POST", path: `${base}/client-scopes`, body: action.representation, expected: [201] };
    case "update-client-scope":
      return {
        method: "PUT",
        path: `${base}/client-scopes/${segment(action.id)}`,
        body: action.representation,
        expected: [204],
      };
    case "create-mapper":
      return { method: "POST", path: `${await scope(action.scope)}/protocol-mappers/models`, body: action.mapper, expected: [201] };
    case "update-mapper":
      return {
        method: "PUT",
        path: `${await scope(action.scope)}/protocol-mappers/models/${segment(action.id)}`,
        body: action.mapper,
        expected: [204],
      };
    case "delete-mapper":
      return {
        method: "DELETE",
        path: `${await scope(action.scope)}/protocol-mappers/models/${segment(action.id)}`,
        expected: [204],
      };
    case "add-scope-roles": {
      const owner = action.target.type === "client" ? await client(action.target.clientId) : await scope(action.target.name);
      return {
        method: "POST",
        path: `${owner}/scope-mappings/clients/${segment(await context.clientUuid(action.roleClientId))}`,
        body: await roles(action.roleClientId, action.roles),
        expected: [204],
      };
    }
    case "remove-optional-scope":
      return {
        method: "DELETE",
        path: `${await client(action.clientId)}/optional-client-scopes/${segment(await context.clientScopeId(action.scope))}`,
        expected: [204],
      };
    case "add-default-scope":
      return {
        method: "PUT",
        path: `${await client(action.clientId)}/default-client-scopes/${segment(await context.clientScopeId(action.scope))}`,
        expected: [204],
      };
    case "map-roles":
    case "unmap-roles": {
      const subject =
        action.subject.type === "user"
          ? await context.userId(action.subject.username)
          : await context.serviceAccountUserId(action.subject.clientId);
      return {
        method: action.kind === "map-roles" ? "POST" : "DELETE",
        path: `${base}/users/${segment(subject)}/role-mappings/clients/${segment(await context.clientUuid(action.roleClientId))}`,
        body: await roles(action.roleClientId, action.roles),
        expected: [204],
      };
    }
    case "create-user": {
      const value = await context.temporaryPassword(action.username);
      return {
        method: "POST",
        path: `${base}/users`,
        body: { ...action.representation, credentials: [{ type: "password", value, temporary: true }] },
        expected: [201],
      };
    }
  }
}

/** An object a create request makes, whose id the Location header of the answer holds. */
export interface CreatedObject {
  kind: "client" | "client-scope" | "user";
  /** The clientId, scope name or username. */
  key: string;
}

/** The object whose id a create action's answer names; a role's Location names the role, not its id. */
export function createdObject(action: KeycloakAction): CreatedObject | undefined {
  if (action.kind === "create-client") return { kind: "client", key: action.clientId };
  if (action.kind === "create-client-scope") return { kind: "client-scope", key: action.name };
  if (action.kind === "create-user") return { kind: "user", key: action.username };
  return undefined;
}

/** The id at the end of a create's Location header. */
export function idFromLocation(location: string | null, what: string): string {
  const id = location?.split("/").at(-1);
  if (id === undefined || id === "") throw new Error(`Keycloak created ${what} without a Location header that names its id`);
  return id;
}
