import { describe, expect, test } from "bun:test";
import type { KeycloakAction } from "../../../src/keycloak/planner";
import { adminRequest, createdObject, idFromLocation } from "../../../src/keycloak/requests";
import { fakeRequestContext } from "./fixture";

const REALM = "/admin/realms/corp";

async function requestOf(action: KeycloakAction) {
  const request = await adminRequest("corp", action, fakeRequestContext({ alice: "alice-temporary" }));
  return { line: `${request.method} ${request.path}`, body: request.body, expected: request.expected };
}

describe("adminRequest", () => {
  test("maps every action to one Admin REST request of the realm", async () => {
    const mapper = { name: "m", protocol: "openid-connect", protocolMapper: "x", config: {} };
    const role = { id: "rid-libredb-user", name: "user" };
    const realm = { id: "r1", realm: "corp", bruteForceProtected: true, attributes: { "libredb.managed": "true" } };
    expect(await requestOf({ kind: "update-realm", representation: realm, summary: "" })).toEqual({
      line: `PUT ${REALM}`,
      body: realm,
      expected: [204],
    });
    expect(await requestOf({ kind: "create-role", clientId: "libredb", role: { name: "user" }, summary: "" })).toEqual({
      line: `POST ${REALM}/clients/cid-libredb/roles`,
      body: { name: "user" },
      expected: [201],
    });
    expect(
      await requestOf({ kind: "update-client-scope", name: "s", id: "s1", representation: { name: "s", protocol: "openid-connect" }, summary: "" }),
    ).toEqual({ line: `PUT ${REALM}/client-scopes/s1`, body: { name: "s", protocol: "openid-connect" }, expected: [204] });
    expect(await requestOf({ kind: "create-mapper", scope: "s", mapper, summary: "" })).toEqual({
      line: `POST ${REALM}/client-scopes/sid-s/protocol-mappers/models`,
      body: mapper,
      expected: [201],
    });
    expect(await requestOf({ kind: "update-mapper", scope: "s", id: "m1", mapper: { ...mapper, id: "m1" }, summary: "" })).toEqual({
      line: `PUT ${REALM}/client-scopes/sid-s/protocol-mappers/models/m1`,
      body: { ...mapper, id: "m1" },
      expected: [204],
    });
    expect(await requestOf({ kind: "delete-mapper", scope: "s", id: "m1", name: "m", summary: "" })).toEqual({
      line: `DELETE ${REALM}/client-scopes/sid-s/protocol-mappers/models/m1`,
      body: undefined,
      expected: [204],
    });
    expect(await requestOf({ kind: "remove-optional-scope", clientId: "app", scope: "email", summary: "" })).toEqual({
      line: `DELETE ${REALM}/clients/cid-app/optional-client-scopes/sid-email`,
      body: undefined,
      expected: [204],
    });
    expect(
      await requestOf({
        kind: "unmap-roles",
        subject: { type: "user", username: "alice" },
        roleClientId: "libredb",
        roles: ["user"],
        summary: "",
      }),
    ).toEqual({ line: `DELETE ${REALM}/users/uid-alice/role-mappings/clients/cid-libredb`, body: [role], expected: [204] });
    expect(
      await requestOf({
        kind: "unmap-roles",
        subject: { type: "service-account", clientId: "app" },
        roleClientId: "libredb",
        roles: ["user"],
        summary: "",
      }),
    ).toEqual({ line: `DELETE ${REALM}/users/sa-app/role-mappings/clients/cid-libredb`, body: [role], expected: [204] });
  });

  test("encodes every path segment it interpolates", async () => {
    const request = await adminRequest(
      "corp",
      { kind: "update-client", clientId: "a/b", id: "x/y", representation: { clientId: "a/b" }, summary: "" },
      fakeRequestContext(),
    );
    expect(request.path).toBe(`${REALM}/clients/x%2Fy`);
  });

  test("a user create sends the stored temporary password, and fails without one", async () => {
    const action: KeycloakAction = {
      kind: "create-user",
      username: "alice",
      representation: { username: "alice", enabled: true, requiredActions: ["UPDATE_PASSWORD"] },
      summary: "",
    };
    expect((await requestOf(action)).body).toEqual({
      username: "alice",
      enabled: true,
      requiredActions: ["UPDATE_PASSWORD"],
      credentials: [{ type: "password", value: "alice-temporary", temporary: true }],
    });
    await expect(adminRequest("corp", { ...action, username: "bob" }, fakeRequestContext())).rejects.toThrow(
      "no temporary password for bob",
    );
  });
});

describe("createdObject", () => {
  test("names the object whose id the Location header of a create holds", () => {
    expect(createdObject({ kind: "create-client", clientId: "app", representation: { clientId: "app" }, summary: "" })).toEqual({
      kind: "client",
      key: "app",
    });
    expect(
      createdObject({ kind: "create-client-scope", name: "s", representation: { name: "s", protocol: "openid-connect" }, summary: "" }),
    ).toEqual({ kind: "client-scope", key: "s" });
    expect(createdObject({ kind: "create-user", username: "alice", representation: { username: "alice" }, summary: "" })).toEqual({
      kind: "user",
      key: "alice",
    });
    expect(createdObject({ kind: "create-role", clientId: "app", role: { name: "r" }, summary: "" })).toBeUndefined();
  });

  test("idFromLocation reads the last path segment and refuses a missing or empty Location", () => {
    expect(idFromLocation("http://127.0.0.1:18080/admin/realms/corp/clients/0f1e", "client app")).toBe("0f1e");
    expect(() => idFromLocation(null, "client app")).toThrow("Keycloak created client app without a Location header");
    expect(() => idFromLocation("http://k/admin/realms/corp/clients/", "client app")).toThrow(
      "Keycloak created client app without a Location header",
    );
  });
});
