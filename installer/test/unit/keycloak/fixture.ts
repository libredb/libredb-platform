import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/load";
import { desiredKeycloak, type DesiredKeycloak } from "../../../src/keycloak/desired";
import type {
  ObservedClient,
  ObservedKeycloak,
  ObservedUser,
  RealmRepresentation,
  RoleRef,
} from "../../../src/keycloak/representations";
import type { RequestContext } from "../../../src/keycloak/requests";
import { computeDesired } from "../../../src/model/desired";
import { manifestFixture } from "../release/fixture";

const root = join(import.meta.dir, "..", "..", "..");

/** The client secrets the converged fixtures were captured with. */
export const CLIENT_SECRETS = {
  studio: "studio-client-secret-for-tests",
  platform: "platform-client-secret-for-tests",
} as const;

export const PASSWORD_LOCATIONS = {
  firstAdmin: "/opt/libredb/secrets/first-admin.txt",
  userManager: "/opt/libredb/secrets/user-manager.txt",
} as const;

/**
 * The `--set` overrides that turn the minimal Docker fixture into an install against the customer's Keycloak at the
 * fixture's auth host, configured with an admin-cli login of realm master.
 */
export const EXTERNAL_KEYCLOAK_SETS = [
  "keycloak.mode=external",
  "keycloak.external.baseUrl=https://auth.libredb.test",
  "keycloak.external.adminUser=admin",
  "keycloak.external.adminPasswordEnv=CORP_KEYCLOAK_ADMIN_PASSWORD",
] as const;

/**
 * The `--set` overrides that turn the minimal Docker fixture into an install against a realm the customer's identity
 * team configured from the export, with only the two app client secrets.
 */
export const MANUAL_KEYCLOAK_SETS = [
  "keycloak.mode=external",
  "keycloak.external.baseUrl=https://auth.libredb.test",
  "keycloak.external.provisioning=manual",
  "keycloak.external.studioClientSecretEnv=CORP_STUDIO_CLIENT_SECRET",
  "keycloak.external.platformClientSecretFile=/root/corp-platform-client-secret",
] as const;

/** The desired Keycloak objects of the minimal Docker fixture, plus `--set` overrides. */
export function desiredFixture(sets: readonly string[] = []): DesiredKeycloak {
  const config = loadConfig({ file: join(root, "test", "fixtures", "configs", "docker-minimal.yaml"), sets });
  return desiredKeycloak({
    installation: computeDesired(config, manifestFixture()),
    keycloak: config.keycloak,
    clientSecrets: CLIENT_SECRETS,
    passwordLocations: PASSWORD_LOCATIONS,
  });
}

function keycloakFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(root, "test", "fixtures", "keycloak", `${name}.json`), "utf8"));
}

/**
 * An observed realm from test/fixtures/keycloak, as a fresh mutable object per call. Every fixture is realm libredb of a
 * managed Keycloak, so each shares managed-realm.json: GET /admin/realms/libredb of Keycloak 26.8.1 right after the
 * handover created the realm.
 */
export function observedFixture(name: string): ObservedKeycloak {
  return {
    ...(keycloakFixture(name) as ObservedKeycloak),
    realmRepresentation: keycloakFixture("managed-realm") as RealmRepresentation,
  };
}

/** The realm representation of an observation, which every fixture holds. */
export function realmOf(observed: ObservedKeycloak): RealmRepresentation {
  if (observed.realmRepresentation === undefined) throw new Error("the observation holds no realm representation");
  return observed.realmRepresentation;
}

export function clientOf(observed: ObservedKeycloak, clientId: string): ObservedClient {
  const client = observed.clients.find((candidate) => candidate.representation.clientId === clientId);
  if (client === undefined) throw new Error(`the fixture has no client ${clientId}`);
  return client;
}

export function userOf(observed: ObservedKeycloak, username: string): ObservedUser {
  const user = observed.users.find((candidate) => candidate.username === username);
  if (user === undefined) throw new Error(`the fixture has no user ${username}`);
  return user;
}

/** The converged realm: the drifted fixture with the redirect URI of libredb-studio set back to the desired one. */
export function convergedFixture(): ObservedKeycloak {
  const observed = observedFixture("drifted-redirect");
  clientOf(observed, "libredb-studio").representation.redirectUris = ["https://studio.libredb.test/api/auth/oidc/callback"];
  return observed;
}

/** A request context that names every object by a readable fake id, such as `cid-libredb-studio`. */
export function fakeRequestContext(passwords: Record<string, string> = {}): RequestContext {
  return {
    clientUuid: async (clientId) => `cid-${clientId}`,
    clientScopeId: async (name) => `sid-${name}`,
    role: async (clientId, name): Promise<RoleRef> => ({ id: `rid-${clientId}-${name}`, name }),
    serviceAccountUserId: async (clientId) => `sa-${clientId}`,
    userId: async (username) => `uid-${username}`,
    temporaryPassword: async (username) => {
      const password = passwords[username];
      if (password === undefined) throw new Error(`no temporary password for ${username}`);
      return password;
    },
  };
}
