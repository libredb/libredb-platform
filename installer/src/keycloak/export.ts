// The installer's export of the Keycloak objects that Platform and Studio rely on, for a site whose identity team
// configures its realm itself (`keycloak.external.provisioning: manual`). It is the converge the installer would run
// against an empty realm: the same desired objects, planned by the same planner and rendered by the same Admin REST
// request builder, so the export never drifts from what the installer sends. The ids of the objects a request names
// are placeholders, which the identity team replaces with the ids Keycloak gives the objects. The export holds no
// secret and no user: Keycloak generates each client secret, and the realm's users stay with the customer.
import type { DesiredInstallation } from "../model/desired";
import { desiredKeycloak, PLATFORM_DIRECTORY_ROLES, REALM_MANAGEMENT } from "./desired";
import { planKeycloak } from "./planner";
import type { ObservedKeycloak } from "./representations";
import { adminRequest, type AdminRequest, type RequestContext } from "./requests";

/** The file `keycloak export` writes into its output directory. */
export const EXPORT_FILE = "libredb-keycloak-export.json";

/** One Admin REST request of the export, in the order the identity team sends them. */
export interface ExportedRequest extends AdminRequest {
  /** What the request does, as the installer's plan names it. */
  summary: string;
}

export interface KeycloakExport {
  realm: string;
  /** The issuer both apps trust, `<keycloak.external.baseUrl>/realms/<realm>`. */
  issuer: string;
  /** The placeholders the paths and bodies use for the ids that Keycloak assigns. */
  placeholders: string[];
  requests: ExportedRequest[];
}

const PLACEHOLDERS = [
  "(client.<clientId>): the id of the client with that clientId",
  "(client-scope.<name>): the id of the client scope with that name",
  "(role.<clientId>.<role>): the id of that role of the client with that clientId",
  "(service-account.<clientId>): the id of the service account user of the client with that clientId",
];

/** Names every object by a placeholder that encodeURIComponent keeps as it is. */
export const placeholderContext: RequestContext = {
  clientUuid: async (clientId) => `(client.${clientId})`,
  clientScopeId: async (name) => `(client-scope.${name})`,
  role: async (clientId, name) => ({ id: `(role.${clientId}.${name})`, name }),
  serviceAccountUserId: async (clientId) => `(service-account.${clientId})`,
  userId: async (username) => {
    throw new Error(`the export creates no user, and a request names user ${username}`);
  },
  temporaryPassword: async (username) => {
    throw new Error(`the export creates no user, and a request asks for the password of ${username}`);
  },
};

/** A realm that holds only what every Keycloak 26 realm holds: realm-management with its roles. */
function emptyRealm(realm: string): ObservedKeycloak {
  return {
    realm,
    defaultClientScopes: [],
    clientScopes: [],
    clients: [
      {
        representation: { id: `(client.${REALM_MANAGEMENT})`, clientId: REALM_MANAGEMENT },
        roles: PLATFORM_DIRECTORY_ROLES.map((name) => ({ name })),
        scopeMappings: {},
      },
    ],
    users: [],
    createdUsers: [],
  };
}

/** The export of the Keycloak objects for the configured realm and hosts. */
export async function keycloakExport(
  installation: Pick<DesiredInstallation, "realm" | "issuer" | "clients">,
): Promise<KeycloakExport> {
  const desired = desiredKeycloak({
    // The realm is the site's, so the export holds none of its settings.
    installation: { ...installation, keycloak: { managed: false } },
    keycloak: { firstAdmin: { enabled: false, username: "" }, userManager: { enabled: false, username: "" } },
    clientSecrets: undefined,
    passwordLocations: { firstAdmin: "", userManager: "" },
  });
  const requests: ExportedRequest[] = [];
  for (const action of planKeycloak(desired, emptyRealm(installation.realm))) {
    requests.push({ summary: action.summary, ...(await adminRequest(installation.realm, action, placeholderContext)) });
  }
  return { realm: installation.realm, issuer: installation.issuer, placeholders: [...PLACEHOLDERS], requests };
}

/** The export as the file holds it: indented JSON with a final line break. */
export function renderExport(exported: KeycloakExport): string {
  return `${JSON.stringify(exported, null, 2)}\n`;
}
