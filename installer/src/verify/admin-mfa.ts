// The warning check admin-mfa of `verify`: every account that holds libredb:admin, or that can administer the realm's
// users through the realm-management role manage-users or its composite realm-admin, must have a second factor,
// because a Platform admin can grant any connection, also to itself, and a user manager can give libredb:admin to
// anyone. The check lists the holders of those roles, directly and through groups and their subgroups as Platform's
// directory reads them, and warns naming each one without an OTP credential. Service accounts, such as that of
// libredb-installer, which holds realm-admin, are left out, because they never sign in interactively. A role held
// only through a composite role is not listed: such an assignment is unsupported, because directory sync does not
// see it.
import { REALM_MANAGEMENT, ROLE_CLIENT_ID } from "../keycloak/desired";
import type { Check, CheckOutcome } from "./catalogue";

/** The Admin API reads the check needs: a GET that answers the parsed body of a 200 and throws otherwise. */
export interface AdminReader {
  get<T>(path: string): Promise<T>;
}

export interface AdminMfaContext {
  /** The realm of the installation. */
  realm: string;
  /** The Admin API of the realm, or why the installer has no admin credential for it. */
  admin: AdminReader | { unavailable: string };
}

type AdminMfaChecks = { keycloak: AdminMfaContext };

/** The client roles whose holders need a second factor, as the warning names them. */
export const MFA_ROLES: readonly { client: string; role: string; label: string }[] = [
  { client: ROLE_CLIENT_ID, role: "admin", label: "libredb:admin" },
  { client: REALM_MANAGEMENT, role: "manage-users", label: "realm-management manage-users" },
  { client: REALM_MANAGEMENT, role: "realm-admin", label: "realm-management realm-admin" },
];

/** The Keycloak credential type of a TOTP device. */
export const OTP_CREDENTIAL = "otp";

export const ADMIN_MFA_PAGE_SIZE = 100;

interface UserEntry {
  id: string;
  username: string;
}

/** The username prefix of a client's service account user, `service-account-<clientId in lowercase>`. */
const SERVICE_ACCOUNT_PREFIX = "service-account-";

interface Holder {
  username: string;
  roles: string[];
}

/** Reads every page of a list endpoint, `briefRepresentation` as asked. */
async function paged<T>(admin: AdminReader, path: string, brief: boolean): Promise<T[]> {
  const items: T[] = [];
  let page: T[];
  do {
    const query = new URLSearchParams({
      first: String(items.length),
      max: String(ADMIN_MFA_PAGE_SIZE),
      briefRepresentation: String(brief),
    });
    page = await admin.get<T[]>(`${path}?${query.toString()}`);
    items.push(...page);
  } while (page.length === ADMIN_MFA_PAGE_SIZE);
  return items;
}

async function clientUuid(admin: AdminReader, base: string, realm: string, clientId: string, label: string): Promise<string> {
  const clients = await admin.get<{ id: string; clientId: string }[]>(
    `${base}/clients?${new URLSearchParams({ clientId }).toString()}`,
  );
  const client = clients.find((candidate) => candidate.clientId === clientId);
  if (client === undefined) throw new Error(`realm ${realm} has no client ${clientId}, so the holders of ${label} cannot be listed`);
  return client.id;
}

/** The users that hold a client role directly, or as members of a group that holds it or of any group below one. */
async function roleHolders(admin: AdminReader, base: string, clientUuidValue: string, role: string): Promise<UserEntry[]> {
  const rolePath = `${base}/clients/${encodeURIComponent(clientUuidValue)}/roles/${encodeURIComponent(role)}`;
  const users = await paged<UserEntry>(admin, `${rolePath}/users`, false);
  const visited = new Set<string>();
  let level = (await paged<{ id: string }>(admin, `${rolePath}/groups`, true)).map((group) => group.id);
  while (level.length > 0) {
    const next: string[] = [];
    for (const id of level) {
      if (visited.has(id)) continue;
      visited.add(id);
      const group = `${base}/groups/${encodeURIComponent(id)}`;
      users.push(...(await paged<UserEntry>(admin, `${group}/members`, false)));
      next.push(...(await paged<{ id: string }>(admin, `${group}/children`, true)).map((child) => child.id));
    }
    level = next;
  }
  return users;
}

/**
 * Whether a user is the service account of a client. Keycloak 26 leaves serviceAccountClientLink out of the users it
 * lists, and a person may be named service-account-<x> too, so a user of that name is a service account only when a
 * client <x> with service accounts names that user as its service account user.
 */
async function isServiceAccount(admin: AdminReader, base: string, user: UserEntry): Promise<boolean> {
  if (!user.username.startsWith(SERVICE_ACCOUNT_PREFIX)) return false;
  const clientId = user.username.slice(SERVICE_ACCOUNT_PREFIX.length);
  const clients = await admin.get<{ id: string; clientId: string; serviceAccountsEnabled?: boolean }[]>(
    `${base}/clients?${new URLSearchParams({ clientId, search: "true" }).toString()}`,
  );
  for (const client of clients) {
    if (client.clientId.toLowerCase() !== clientId || client.serviceAccountsEnabled !== true) continue;
    const account = await admin.get<UserEntry>(`${base}/clients/${encodeURIComponent(client.id)}/service-account-user`);
    if (account.id === user.id) return true;
  }
  return false;
}

function plural(count: number): string {
  const reason = "and every governance install requires Keycloak MFA for";
  return count === 1
    ? `1 account holds libredb:admin or manage-users without an OTP credential, ${reason} it`
    : `${count} accounts hold libredb:admin or manage-users without an OTP credential, ${reason} them`;
}

/**
 * admin-mfa: a warning, never a failure, naming every holder of libredb:admin, manage-users or realm-admin that has no
 * OTP credential; without an admin credential it warns that it did not run.
 */
export const adminMfaCheck: Check<AdminMfaChecks> = {
  id: "admin-mfa",
  async run({ keycloak }): Promise<CheckOutcome> {
    const { admin, realm } = keycloak;
    if ("unavailable" in admin) {
      return { passed: true, warning: `not checked, because the installer has no Keycloak admin credential: ${admin.unavailable}` };
    }
    const base = `/admin/realms/${encodeURIComponent(realm)}`;
    const holders = new Map<string, Holder>();
    const serviceAccounts = new Set<string>();
    const uuids = new Map<string, string>();
    for (const { client, role, label } of MFA_ROLES) {
      let uuid = uuids.get(client);
      if (uuid === undefined) {
        uuid = await clientUuid(admin, base, realm, client, label);
        uuids.set(client, uuid);
      }
      for (const user of await roleHolders(admin, base, uuid, role)) {
        if (serviceAccounts.has(user.id)) continue;
        let holder = holders.get(user.id);
        if (holder === undefined) {
          if (await isServiceAccount(admin, base, user)) {
            serviceAccounts.add(user.id);
            continue;
          }
          holder = { username: user.username, roles: [] };
          holders.set(user.id, holder);
        }
        if (!holder.roles.includes(label)) holder.roles.push(label);
      }
    }
    const missing: Holder[] = [];
    for (const [id, holder] of holders) {
      const credentials = await admin.get<{ type: string }[]>(`${base}/users/${encodeURIComponent(id)}/credentials`);
      if (!credentials.some((credential) => credential.type === OTP_CREDENTIAL)) missing.push(holder);
    }
    if (missing.length === 0) return { passed: true };
    missing.sort((a, b) => a.username.localeCompare(b.username));
    const named = missing.map((holder) => `${holder.username} (${holder.roles.join(", ")})`).join(", ");
    return { passed: true, warning: `${plural(missing.length)}: ${named}` };
  },
};
