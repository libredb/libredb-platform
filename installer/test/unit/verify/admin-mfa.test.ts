import { describe, expect, test } from "bun:test";
import { adminMfaCheck, ADMIN_MFA_PAGE_SIZE, type AdminMfaContext, type AdminReader } from "../../../src/verify/admin-mfa";

const REALM = "libredb";
const BASE = `/admin/realms/${REALM}`;
const LIBREDB_CLIENT = "c-libredb";
const REALM_MANAGEMENT_CLIENT = "c-realm-management";

interface FakeUser {
  id: string;
  username: string;
  credentials: string[];
}

interface FakeClient {
  id: string;
  clientId: string;
  serviceAccountsEnabled: boolean;
  serviceAccountUser?: string;
}

/**
 * A realm as the Admin API answers it: the role holders of each client role, directly and through groups, the
 * members and children of each group, and the credential types of each user. Lists are paged by first and max.
 */
class FakeRealm implements AdminReader {
  readonly paths: string[] = [];
  readonly users = new Map<string, FakeUser>();
  readonly clients: FakeClient[] = [
    { id: LIBREDB_CLIENT, clientId: "libredb", serviceAccountsEnabled: false },
    { id: "c-libredb-other", clientId: "libredb-other", serviceAccountsEnabled: false },
    { id: REALM_MANAGEMENT_CLIENT, clientId: "realm-management", serviceAccountsEnabled: false },
  ];
  readonly roleUsers = new Map<string, string[]>();
  readonly roleGroups = new Map<string, string[]>();
  readonly groupMembers = new Map<string, string[]>();
  readonly groupChildren = new Map<string, string[]>();

  user(user: FakeUser): this {
    this.users.set(user.id, user);
    return this;
  }

  async get<T>(path: string): Promise<T> {
    this.paths.push(path);
    const url = new URL(path, "http://keycloak");
    const route = url.pathname;
    // Keycloak 26 lists users without serviceAccountClientLink.
    const userBody = (id: string) => {
      const user = this.users.get(id);
      if (user === undefined) throw new Error(`no user ${id}`);
      return { id: user.id, username: user.username, enabled: true, totp: false };
    };
    if (route === `${BASE}/clients`) {
      // Like Keycloak, clientId matches exactly, or with search=true as a case-insensitive substring.
      const clientId = url.searchParams.get("clientId") ?? "";
      const search = url.searchParams.get("search") === "true";
      return this.clients
        .filter((client) =>
          search ? client.clientId.toLowerCase().includes(clientId.toLowerCase()) : client.clientId.startsWith(clientId),
        )
        .map(({ id, clientId: name, serviceAccountsEnabled }) => ({ id, clientId: name, serviceAccountsEnabled })) as T;
    }
    const serviceAccount = /^\/admin\/realms\/libredb\/clients\/([^/]+)\/service-account-user$/.exec(route);
    if (serviceAccount !== null) {
      const client = this.clients.find((candidate) => candidate.id === serviceAccount[1]);
      if (client?.serviceAccountUser === undefined) throw new Error(`client ${serviceAccount[1]} has no service account`);
      return userBody(client.serviceAccountUser) as T;
    }
    const page = <V>(items: readonly V[]): T => {
      const first = Number(url.searchParams.get("first"));
      const max = Number(url.searchParams.get("max"));
      expect(url.searchParams.get("briefRepresentation")).not.toBeNull();
      return items.slice(first, first + max) as T;
    };
    let match = /^\/admin\/realms\/libredb\/clients\/([^/]+)\/roles\/([^/]+)\/(users|groups)$/.exec(route);
    if (match !== null) {
      const key = `${match[1]}/${decodeURIComponent(match[2] ?? "")}`;
      if (match[3] === "users") return page((this.roleUsers.get(key) ?? []).map(userBody));
      return page((this.roleGroups.get(key) ?? []).map((id) => ({ id, name: id })));
    }
    match = /^\/admin\/realms\/libredb\/groups\/([^/]+)\/(members|children)$/.exec(route);
    if (match !== null) {
      const id = match[1] ?? "";
      if (match[2] === "members") return page((this.groupMembers.get(id) ?? []).map(userBody));
      return page((this.groupChildren.get(id) ?? []).map((child) => ({ id: child, name: child })));
    }
    match = /^\/admin\/realms\/libredb\/users\/([^/]+)\/credentials$/.exec(route);
    if (match !== null) {
      const user = this.users.get(match[1] ?? "");
      if (user === undefined) throw new Error(`no user ${match[1]}`);
      return user.credentials.map((type, index) => ({ id: `${user.id}-${index}`, type })) as T;
    }
    throw new Error(`unexpected path ${path}`);
  }
}

const context = (admin: AdminMfaContext["admin"]): { keycloak: AdminMfaContext } => ({ keycloak: { realm: REALM, admin } });

describe("admin-mfa", () => {
  test("an admin or a user manager without an OTP credential produces a warning naming the user", async () => {
    const realm = new FakeRealm()
      .user({ id: "u-alice", username: "alice", credentials: ["password", "otp"] })
      .user({ id: "u-bob", username: "bob", credentials: ["password"] })
      .user({ id: "u-manager", username: "libredb-user-manager", credentials: ["password"] })
      .user({ id: "u-grace", username: "grace", credentials: ["password"] })
      .user({ id: "u-erin", username: "erin", credentials: ["password", "otp"] })
      .user({ id: "u-root", username: "root-admin", credentials: [] })
      .user({ id: "u-sa", username: "service-account-libredb-installer", credentials: [] })
      .user({ id: "u-fake", username: "service-account-mixed.case", credentials: ["password"] })
      .user({ id: "u-mixed", username: "service-account-mixed.case-sa", credentials: [] });
    // The installer's service account holds realm-admin, and so does a client's whose clientId has capitals; a person
    // named like a service account is still a person.
    realm.clients.push(
      { id: "c-installer", clientId: "libredb-installer", serviceAccountsEnabled: true, serviceAccountUser: "u-sa" },
      { id: "c-mixed", clientId: "Mixed.Case", serviceAccountsEnabled: true, serviceAccountUser: "u-mixed-other" },
      { id: "c-mixed-sa", clientId: "Mixed.Case-SA", serviceAccountsEnabled: true, serviceAccountUser: "u-mixed" },
    );
    realm.user({ id: "u-mixed-other", username: "service-account-mixed.case-other", credentials: [] });
    realm.roleUsers.set(`${LIBREDB_CLIENT}/admin`, ["u-alice", "u-bob"]);
    realm.roleUsers.set(`${REALM_MANAGEMENT_CLIENT}/realm-admin`, ["u-root", "u-sa", "u-fake", "u-mixed"]);
    realm.roleUsers.set(`${REALM_MANAGEMENT_CLIENT}/manage-users`, ["u-manager", "u-sa"]);
    // grace holds libredb:admin through group dba, erin through its subgroup dba/juniors, and bob both ways.
    realm.roleGroups.set(`${LIBREDB_CLIENT}/admin`, ["g-dba"]);
    realm.groupMembers.set("g-dba", ["u-grace", "u-bob"]);
    realm.groupChildren.set("g-dba", ["g-juniors"]);
    realm.groupMembers.set("g-juniors", ["u-erin"]);

    expect(await adminMfaCheck.run(context(realm))).toEqual({
      passed: true,
      warning:
        "5 accounts hold libredb:admin or manage-users without an OTP credential, and every governance install requires " +
        "Keycloak MFA for them: bob (libredb:admin), grace (libredb:admin), libredb-user-manager (realm-management " +
        "manage-users), root-admin (realm-management realm-admin), service-account-mixed.case (realm-management realm-admin)",
    });
    // Each user's credentials are read once, though bob holds the role twice, and a service account's never; the
    // installer's service account is looked up once, though it holds two of the roles.
    const credentialReads = realm.paths.filter((path) => path.endsWith("/credentials"));
    expect(credentialReads.sort()).toEqual(
      ["u-alice", "u-bob", "u-erin", "u-fake", "u-grace", "u-manager", "u-root"].map((id) => `${BASE}/users/${id}/credentials`),
    );
    expect(realm.paths.filter((path) => path.endsWith("/c-installer/service-account-user"))).toHaveLength(1);
  });

  test("one account without an OTP credential is named in the singular", async () => {
    const realm = new FakeRealm().user({ id: "u-bob", username: "bob", credentials: [] });
    realm.roleUsers.set(`${LIBREDB_CLIENT}/admin`, ["u-bob"]);
    expect(await adminMfaCheck.run(context(realm))).toEqual({
      passed: true,
      warning:
        "1 account holds libredb:admin or manage-users without an OTP credential, and every governance install requires " +
        "Keycloak MFA for it: bob (libredb:admin)",
    });
  });

  test("every holder with an OTP credential passes, across pages of role holders", async () => {
    const realm = new FakeRealm();
    const ids: string[] = [];
    for (let index = 0; index < ADMIN_MFA_PAGE_SIZE + 3; index += 1) {
      const id = `u-${index}`;
      realm.user({ id, username: `admin-${index}`, credentials: ["otp", "password"] });
      ids.push(id);
    }
    realm.roleUsers.set(`${LIBREDB_CLIENT}/admin`, ids);
    expect(await adminMfaCheck.run(context(realm))).toEqual({ passed: true });
    expect(realm.paths.filter((path) => path.endsWith("/credentials"))).toHaveLength(ADMIN_MFA_PAGE_SIZE + 3);
    expect(realm.paths).toContain(
      `${BASE}/clients/${LIBREDB_CLIENT}/roles/admin/users?first=${ADMIN_MFA_PAGE_SIZE}&max=${ADMIN_MFA_PAGE_SIZE}&briefRepresentation=false`,
    );
  });

  test("without an admin credential the check warns that it did not run", async () => {
    expect(await adminMfaCheck.run(context({ unavailable: "/opt/libredb/secrets/installer.env does not exist" }))).toEqual({
      passed: true,
      warning:
        "not checked, because the installer has no Keycloak admin credential: /opt/libredb/secrets/installer.env does not exist",
    });
  });

  test("a realm without client libredb fails the check", async () => {
    const realm = new FakeRealm();
    realm.get = async <T>(path: string): Promise<T> => {
      if (path.startsWith(`${BASE}/clients?`)) return [] as T;
      throw new Error(`unexpected path ${path}`);
    };
    await expect(adminMfaCheck.run(context(realm))).rejects.toThrow(
      `realm ${REALM} has no client libredb, so the holders of libredb:admin cannot be listed`,
    );
  });
});
