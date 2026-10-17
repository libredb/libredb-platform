import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/load";
import { EXPORT_FILE, keycloakExport, placeholderContext, renderExport } from "../../../src/keycloak/export";
import { computeDesired } from "../../../src/model/desired";
import { manifestFixture } from "../release/fixture";
import { CLIENT_SECRETS, MANUAL_KEYCLOAK_SETS } from "./fixture";

const root = join(import.meta.dir, "..", "..", "..");

function installation(sets: readonly string[] = MANUAL_KEYCLOAK_SETS) {
  const config = loadConfig({ file: join(root, "test", "fixtures", "configs", "docker-minimal.yaml"), sets });
  return computeDesired(config, manifestFixture());
}

const ROLE_REFS = [
  { id: "(role.libredb.admin)", name: "admin" },
  { id: "(role.libredb.user)", name: "user" },
];
const DIRECTORY_REFS = [
  { id: "(role.realm-management.view-users)", name: "view-users" },
  { id: "(role.realm-management.view-clients)", name: "view-clients" },
];

describe("keycloakExport", () => {
  test("the export holds exactly the LibreDB Keycloak objects for the configured realm and hosts, and no secret", async () => {
    const exported = await keycloakExport(installation([...MANUAL_KEYCLOAK_SETS, "keycloak.realm=corp"]));
    const base = "/admin/realms/corp";
    expect(exported.realm).toBe("corp");
    expect(exported.issuer).toBe("https://auth.libredb.test/realms/corp");
    expect(exported.requests.map(({ summary, method, path }) => ({ summary, method, path }))).toEqual([
      { summary: "create client libredb", method: "POST", path: `${base}/clients` },
      { summary: "create role admin on client libredb", method: "POST", path: `${base}/clients/(client.libredb)/roles` },
      { summary: "create role user on client libredb", method: "POST", path: `${base}/clients/(client.libredb)/roles` },
      { summary: "create client scope libredb-roles", method: "POST", path: `${base}/client-scopes` },
      {
        summary: "map the roles libredb:admin and libredb:user into client scope libredb-roles",
        method: "POST",
        path: `${base}/client-scopes/(client-scope.libredb-roles)/scope-mappings/clients/(client.libredb)`,
      },
      { summary: "create client libredb-studio", method: "POST", path: `${base}/clients` },
      {
        summary: "add default client scope libredb-roles to client libredb-studio",
        method: "PUT",
        path: `${base}/clients/(client.libredb-studio)/default-client-scopes/(client-scope.libredb-roles)`,
      },
      { summary: "create client libredb-platform", method: "POST", path: `${base}/clients` },
      {
        summary: "add default client scope libredb-roles to client libredb-platform",
        method: "PUT",
        path: `${base}/clients/(client.libredb-platform)/default-client-scopes/(client-scope.libredb-roles)`,
      },
      {
        summary: "map the roles realm-management:view-users and realm-management:view-clients into the scope of client libredb-platform",
        method: "POST",
        path: `${base}/clients/(client.libredb-platform)/scope-mappings/clients/(client.realm-management)`,
      },
      {
        summary: "grant realm-management:view-users and realm-management:view-clients to the service account of client libredb-platform",
        method: "POST",
        path: `${base}/users/(service-account.libredb-platform)/role-mappings/clients/(client.realm-management)`,
      },
    ]);
    const bodies = exported.requests.map((request) => request.body);
    expect(bodies[1]).toMatchObject({ name: "admin", attributes: { "libredb.managed": ["true"] } });
    expect(bodies[4]).toEqual(ROLE_REFS);
    expect(bodies[9]).toEqual(DIRECTORY_REFS);
    expect(bodies[10]).toEqual(DIRECTORY_REFS);
    expect(bodies[3]).toMatchObject({
      name: "libredb-roles",
      protocolMappers: [
        {
          protocolMapper: "oidc-usermodel-client-role-mapper",
          config: { "usermodel.clientRoleMapping.clientId": "libredb", "claim.name": "libredb_roles" },
        },
      ],
    });
    expect(bodies[5]).toMatchObject({
      clientId: "libredb-studio",
      publicClient: false,
      standardFlowEnabled: true,
      serviceAccountsEnabled: false,
      redirectUris: ["https://studio.libredb.test/api/auth/oidc/callback"],
      attributes: {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "https://studio.libredb.test/login",
      },
    });
    expect(bodies[7]).toMatchObject({
      clientId: "libredb-platform",
      serviceAccountsEnabled: true,
      redirectUris: ["https://platform.libredb.test/api/auth/callback/keycloak"],
      attributes: {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "https://platform.libredb.test/login",
        "use.refresh.tokens": "true",
      },
    });
    // No user: the realm's users and their role assignments stay with the customer's identity team.
    expect(exported.requests.some((request) => request.path.includes("/users") && request.method === "POST" && !request.path.includes("role-mappings"))).toBe(false);
    // No secret: Keycloak generates each client secret, and the site shares the two app client secrets afterwards.
    const text = renderExport(exported);
    expect(text).not.toContain('"secret"');
    expect(text).not.toContain(CLIENT_SECRETS.studio);
    expect(text).not.toContain(CLIENT_SECRETS.platform);
  });

  test("renders the export as indented JSON with a final line break, in the file the command writes", async () => {
    const exported = await keycloakExport(installation());
    const text = renderExport(exported);
    expect(EXPORT_FILE).toBe("libredb-keycloak-export.json");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(exported)));
    expect(exported.realm).toBe("libredb");
    expect(exported.placeholders.map((placeholder) => placeholder.split(":")[0])).toEqual([
      "(client.<clientId>)",
      "(client-scope.<name>)",
      "(role.<clientId>.<role>)",
      "(service-account.<clientId>)",
    ]);
  });

  test("names objects by placeholders, and refuses a request for a user, which the export never creates", async () => {
    expect(await placeholderContext.clientUuid("libredb")).toBe("(client.libredb)");
    expect(await placeholderContext.clientScopeId("libredb-roles")).toBe("(client-scope.libredb-roles)");
    expect(await placeholderContext.role("libredb", "admin")).toEqual({ id: "(role.libredb.admin)", name: "admin" });
    expect(await placeholderContext.serviceAccountUserId("libredb-platform")).toBe("(service-account.libredb-platform)");
    await expect(placeholderContext.userId("alice")).rejects.toThrow("the export creates no user, and a request names user alice");
    await expect(placeholderContext.temporaryPassword("alice")).rejects.toThrow(
      "the export creates no user, and a request asks for the password of alice",
    );
  });
});
