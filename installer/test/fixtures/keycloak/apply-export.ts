// Applies the installer's Keycloak export to a realm the way a site's identity team would with its own administrator:
// each request in order, with every placeholder replaced by the id Keycloak gave the object it names.
import type { KeycloakAdmin } from "../../../src/adapters/keycloak-admin";
import type { ExportedRequest, KeycloakExport } from "../../../src/keycloak/export";

const PLACEHOLDER = /\((client|client-scope|role|service-account)\.([^()]+)\)/g;

async function resolve(admin: KeycloakAdmin, realm: string, kind: string, key: string): Promise<string> {
  const base = `/admin/realms/${encodeURIComponent(realm)}`;
  const client = async (clientId: string) => {
    const [found] = await admin.get<{ id: string }[]>(`${base}/clients?clientId=${encodeURIComponent(clientId)}`);
    if (found === undefined) throw new Error(`realm ${realm} has no client ${clientId}`);
    return found.id;
  };
  switch (kind) {
    case "client":
      return client(key);
    case "client-scope": {
      const scope = (await admin.get<{ id: string; name: string }[]>(`${base}/client-scopes`)).find((entry) => entry.name === key);
      if (scope === undefined) throw new Error(`realm ${realm} has no client scope ${key}`);
      return scope.id;
    }
    case "role": {
      const dot = key.lastIndexOf(".");
      const clientId = key.slice(0, dot);
      const name = key.slice(dot + 1);
      return (await admin.get<{ id: string }>(`${base}/clients/${await client(clientId)}/roles/${encodeURIComponent(name)}`)).id;
    }
    default:
      return (await admin.get<{ id: string }>(`${base}/clients/${await client(key)}/service-account-user`)).id;
  }
}

async function substitute(admin: KeycloakAdmin, realm: string, text: string): Promise<string> {
  let out = text;
  for (const [placeholder, kind, key] of text.matchAll(PLACEHOLDER)) {
    out = out.replaceAll(placeholder, await resolve(admin, realm, kind as string, key as string));
  }
  return out;
}

/** Sends every request of the export that `include` keeps, in order, as the given administrator. */
export async function applyExport(
  admin: KeycloakAdmin,
  exported: KeycloakExport,
  include: (request: ExportedRequest) => boolean = () => true,
): Promise<void> {
  for (const request of exported.requests.filter(include)) {
    const path = await substitute(admin, exported.realm, request.path);
    const body =
      request.body === undefined ? undefined : JSON.parse(await substitute(admin, exported.realm, JSON.stringify(request.body)));
    await admin.write(request.method, path, body, request.expected);
  }
}

/** Whether a request grants roles to the service account of a client, which the identity team assigns by hand. */
export const grantsServiceAccountRoles = (request: ExportedRequest): boolean => request.path.includes("(service-account.");
