import { describe, expect, test } from "bun:test";
import { KeycloakAdmin, KeycloakAdminError, requestToken } from "../../../src/adapters/keycloak-admin";

const credentials = { realm: "libredb", clientId: "libredb-installer", clientSecret: "client-secret-value" };

/** A fake Keycloak that answers token requests with numbered tokens and Admin API calls from a script. */
function fakeKeycloak(adminStatuses: number[], tokenStatus = 200) {
  const calls: { method: string; path: string; authorization: string | null; body: string }[] = [];
  let issued = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (url.pathname.endsWith("/protocol/openid-connect/token")) {
      if (tokenStatus !== 200) return Response.json({ error: "invalid_client" }, { status: tokenStatus });
      issued += 1;
      return Response.json({ access_token: `token-${issued}` });
    }
    const status = adminStatuses.shift() ?? 200;
    return status === 204 ? new Response(null, { status }) : Response.json({ realm: "libredb" }, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("KeycloakAdmin", () => {
  test("gets a client-credentials token from the realm's token endpoint on the loopback base URL", async () => {
    const { calls, fetchImpl } = fakeKeycloak([200]);
    const admin = new KeycloakAdmin({ baseUrl: "http://127.0.0.1:18080", credentials, log: () => {}, fetch: fetchImpl });
    expect(await admin.get<{ realm: string }>("/admin/realms/libredb")).toEqual({ realm: "libredb" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /realms/libredb/protocol/openid-connect/token",
      "GET /admin/realms/libredb",
    ]);
    expect(new URLSearchParams(calls[0]?.body).get("grant_type")).toBe("client_credentials");
    expect(calls[1]?.authorization).toBe("Bearer token-1");
  });

  test("retries a 401 once with a fresh token, and fails on a second 401", async () => {
    const retried = fakeKeycloak([401, 200]);
    const admin = new KeycloakAdmin({ baseUrl: "http://k", credentials, log: () => {}, fetch: retried.fetchImpl });
    expect((await admin.request("GET", "/admin/realms/libredb")).status).toBe(200);
    expect(retried.calls.filter((call) => call.path.startsWith("/admin/")).map((call) => call.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);

    const refused = fakeKeycloak([401, 401]);
    const again = new KeycloakAdmin({ baseUrl: "http://k", credentials, log: () => {}, fetch: refused.fetchImpl });
    await expect(again.get("/admin/realms/libredb")).rejects.toThrow("Keycloak answered GET /admin/realms/libredb with 401");
  });

  test("logs the method, path and status of every request but never a token or a secret", async () => {
    const lines: string[] = [];
    const { fetchImpl } = fakeKeycloak([401, 201]);
    const admin = new KeycloakAdmin({ baseUrl: "http://k", credentials, log: (line) => lines.push(line), fetch: fetchImpl });
    await admin.write("POST", "/admin/realms", { realm: "libredb" }, [201]);
    expect(lines).toEqual([
      "keycloak POST /realms/libredb/protocol/openid-connect/token as libredb-installer 200",
      "keycloak POST /admin/realms 401",
      "keycloak POST /realms/libredb/protocol/openid-connect/token as libredb-installer 200",
      "keycloak POST /admin/realms 201",
    ]);
    for (const line of lines) {
      expect(line).not.toContain("token-");
      expect(line).not.toContain(credentials.clientSecret);
    }
  });

  test("find returns undefined on 404, and a write with an unexpected status throws naming method, path and status", async () => {
    const { fetchImpl } = fakeKeycloak([404, 409]);
    const admin = new KeycloakAdmin({ baseUrl: "http://k", credentials, log: () => {}, fetch: fetchImpl });
    expect(await admin.find("/admin/realms/libredb")).toBeUndefined();
    const error = await admin.write("POST", "/admin/realms", {}, [201]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KeycloakAdminError);
    expect((error as KeycloakAdminError).message).toBe("Keycloak answered POST /admin/realms with 409");
  });

  test("refuses a path outside the Admin API", async () => {
    const { fetchImpl } = fakeKeycloak([]);
    const admin = new KeycloakAdmin({ baseUrl: "http://k", credentials, log: () => {}, fetch: fetchImpl });
    await expect(admin.request("GET", "/realms/master")).rejects.toThrow("not an Admin API path: /realms/master");
  });

  test("requestToken returns the status of a refused client instead of throwing", async () => {
    const { fetchImpl } = fakeKeycloak([], 401);
    expect(await requestToken({ baseUrl: "http://k", log: () => {}, fetch: fetchImpl }, credentials)).toEqual({
      status: 401,
    });
  });
});
