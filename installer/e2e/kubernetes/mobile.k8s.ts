// The mobile app on a Helm install with mobile.enabled, which run-e2e.sh turns on in an upgrade: a Keycloak user signs
// in through the public client libredb-mobile with the authorization code flow and PKCE S256, as the app does, and the
// access token holds what Studio's bearer channel and Platform's bearer API check (docs/api/v1.md): typ Bearer, both
// audiences libredb-studio-api and libredb-platform-api, and azp libredb-mobile. The login pages are reached through
// the port-forward to Service keycloak that k8s.ts opens, while the pages name Keycloak's public URL, as the
// installer's Keycloak integration test does. Without LIBREDB_E2E_MOBILE=1 the suite skips.
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createKeycloakUser, deleteKeycloakUser, keycloakAdminUrl, stopKeycloakForward, type KeycloakUser } from "./k8s";

test.skip(process.env.LIBREDB_E2E_MOBILE !== "1", "run by run-e2e.sh after its upgrade with mobile.enabled");
test.describe.configure({ mode: "serial" });

const REALM = "libredb";
const CLIENT_ID = "libredb-mobile";
const REDIRECT_URI = process.env.LIBREDB_E2E_MOBILE_REDIRECT_URI ?? "org.libredb.mobile:/oauth2redirect";

let user: KeycloakUser | undefined;

test.afterAll(async () => {
  if (user !== undefined) await deleteKeycloakUser(user.id);
  stopKeycloakForward();
});

/** The claims of a JWT's payload, without checking its signature, which the apps do. */
function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

/** The app's sign-in: the authorization request with PKCE S256, the login form, the code exchange without a secret. */
async function mobileLogin(base: string, account: KeycloakUser): Promise<{ access: Record<string, unknown>; id: Record<string, unknown> }> {
  const oidc = `${base}/realms/${REALM}/protocol/openid-connect`;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorize = new URL(`${oidc}/auth`);
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid",
    state,
    nonce: randomBytes(16).toString("base64url"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const page = await fetch(authorize, { redirect: "manual" });
  expect(page.status, "the authorization request of libredb-mobile").toBe(200);
  const cookies = page.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0])
    .join("; ");
  const form = /<form\b[^>]*\bid="kc-form-login"[^>]*>/.exec(await page.text())?.[0];
  const action = form === undefined ? undefined : /\baction="([^"]+)"/.exec(form)?.[1]?.replaceAll("&amp;", "&");
  if (action === undefined) throw new Error("the login page has no form kc-form-login with an action");
  const publicAction = new URL(action);
  const submitted = await fetch(`${base}${publicAction.pathname}${publicAction.search}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
    body: new URLSearchParams({ username: account.username, password: account.password, credentialId: "" }),
  });
  const location = submitted.headers.get("location") ?? "";
  expect({ status: submitted.status, toRedirectUri: location.startsWith(REDIRECT_URI) }).toEqual({ status: 302, toRedirectUri: true });
  const callback = new URL(location);
  expect(callback.searchParams.get("state")).toBe(state);
  const token = await fetch(`${oidc}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    }),
  });
  const body = (await token.json()) as { access_token?: string; id_token?: string; error?: string };
  expect(token.status, JSON.stringify({ error: body.error })).toBe(200);
  return { access: claimsOf(body.access_token ?? ""), id: claimsOf(body.id_token ?? "") };
}

test("a PKCE sign-in through libredb-mobile yields one access token for Studio's bearer channel and Platform's bearer API", async () => {
  const base = await keycloakAdminUrl();
  const issuer = ((await (await fetch(`${base}/realms/${REALM}/.well-known/openid-configuration`)).json()) as { issuer: string }).issuer;
  user = await createKeycloakUser(`mobile-${Date.now().toString(36)}`, "user");
  const { access, id } = await mobileLogin(base, user);
  const audience = typeof access.aud === "string" ? [access.aud] : (access.aud as string[]);
  expect(audience).toContain("libredb-studio-api");
  expect(audience).toContain("libredb-platform-api");
  // Studio refuses a bearer whose audience names its web client, the audience of its ID tokens.
  expect(audience).not.toContain("libredb-studio");
  expect({
    iss: access.iss,
    typ: access.typ,
    azp: access.azp,
    libredb_roles: access.libredb_roles,
    preferred_username: access.preferred_username,
    email: access.email,
    sub: access.sub,
  }).toEqual({
    iss: issuer,
    typ: "Bearer",
    azp: CLIENT_ID,
    libredb_roles: ["user"],
    preferred_username: user.username,
    email: user.email,
    sub: id.sub,
  });
});

test("libredb-mobile has no password grant", async () => {
  const base = await keycloakAdminUrl();
  if (user === undefined) throw new Error("the sign-in test created no user");
  const response = await fetch(`${base}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: CLIENT_ID, username: user.username, password: user.password }),
  });
  expect({ status: response.status, error: ((await response.json()) as { error?: string }).error }).toEqual({ status: 400, error: "unauthorized_client" });
});
