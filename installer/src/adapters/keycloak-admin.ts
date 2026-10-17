// The Keycloak Admin REST client of the installer. It obtains tokens with client credentials, or with a
// user's password for admin-cli when the customer's Keycloak is reached with an administrator's login, and calls the
// Admin API only through the loopback port of a managed Keycloak or the configured URL of an external one, never
// through the public edge. It retries a call once with a fresh token when Keycloak answers 401, and it logs each
// request's method, path and status but never a token, a secret or a body.
import { rootCertificates } from "node:tls";

/** A confidential client that authenticates with its secret at `/realms/<realm>/protocol/openid-connect/token`. */
export interface ClientCredentials {
  realm: string;
  clientId: string;
  clientSecret: string;
}

/** A user of `realm` that signs in with its password through a public client, such as admin-cli. */
export interface PasswordCredentials {
  realm: string;
  clientId: string;
  username: string;
  password: string;
}

/** How the installer authenticates to the Admin API. */
export type AdminCredentials = ClientCredentials | PasswordCredentials;

export interface KeycloakAdminOptions {
  /** The base URL, such as http://127.0.0.1:18080 or https://sso.corp.example, without a trailing slash. */
  baseUrl: string;
  credentials: AdminCredentials;
  /** Receives one line per request, such as `keycloak GET /admin/realms/libredb 200`. */
  log: (line: string) => void;
  /** The fetch implementation, the global one by default. */
  fetch?: typeof fetch;
}

/** A request Keycloak answered with an unexpected status. The message holds the method, path and status only. */
export class KeycloakAdminError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;

  constructor(method: string, path: string, status: number, detail = "") {
    super(`Keycloak answered ${method} ${path} with ${status}${detail === "" ? "" : `: ${detail}`}`);
    this.name = "KeycloakAdminError";
    this.method = method;
    this.path = path;
    this.status = status;
  }
}

export interface AdminResponse<T> {
  status: number;
  body: T;
  /** The Location header of a create, from which the id of the new object is read. */
  location: string | null;
}

const TIMEOUT_MS = 30_000;

/** The token endpoint path of a realm. */
export function tokenPath(realm: string): string {
  return `/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;
}

// Keycloak's OAuth error bodies name the error, such as invalid_client, and never echo the secret.
async function oauthError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    return "";
  }
}

/** Names the credentials Keycloak refused, never their secret. */
export function describeRefusal(credentials: AdminCredentials): string {
  const who =
    "username" in credentials
      ? `the password of user ${credentials.username} for client ${credentials.clientId}`
      : `the client credentials of ${credentials.clientId}`;
  return `Keycloak refused ${who} in realm ${credentials.realm}`;
}

/**
 * A fetch that trusts the system roots and the given CA certificates, as both apps do with NODE_EXTRA_CA_CERTS, for
 * a customer's Keycloak whose certificate a private CA issued.
 */
export function trustingFetch(caCertificates: readonly string[]): typeof fetch {
  const ca = [...rootCertificates, ...caCertificates];
  return ((input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, tls: { ca } })) as typeof fetch;
}

/**
 * Requests a token with client credentials, or with a user's password for a public client. Returns the access token,
 * or the status when Keycloak refuses the credentials, so a caller can tell a deleted or wrong client (401) from a
 * failure, which it throws.
 */
export async function requestToken(
  options: Pick<KeycloakAdminOptions, "baseUrl" | "log" | "fetch">,
  credentials: AdminCredentials,
): Promise<{ token: string } | { status: number }> {
  const path = tokenPath(credentials.realm);
  const form: Record<string, string> =
    "username" in credentials
      ? { grant_type: "password", client_id: credentials.clientId, username: credentials.username, password: credentials.password }
      : { grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.clientSecret };
  const response = await (options.fetch ?? fetch)(`${options.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const as = "username" in credentials ? `${credentials.username} through ${credentials.clientId}` : credentials.clientId;
  options.log(`keycloak POST ${path} as ${as} ${response.status}`);
  if (response.status === 400 || response.status === 401) {
    await oauthError(response);
    return { status: response.status };
  }
  if (!response.ok) throw new KeycloakAdminError("POST", path, response.status, await oauthError(response));
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new KeycloakAdminError("POST", path, response.status, "the response holds no access_token");
  }
  return { token: body.access_token };
}

export class KeycloakAdmin {
  readonly #options: KeycloakAdminOptions;
  #token: string | undefined;

  constructor(options: KeycloakAdminOptions) {
    this.#options = options;
  }

  async #freshToken(): Promise<string> {
    const { credentials } = this.#options;
    const result = await requestToken(this.#options, credentials);
    if ("status" in result) {
      throw new KeycloakAdminError("POST", tokenPath(credentials.realm), result.status, describeRefusal(credentials));
    }
    this.#token = result.token;
    return result.token;
  }

  async #send(method: string, path: string, token: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await (this.#options.fetch ?? fetch)(`${this.#options.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    this.#options.log(`keycloak ${method} ${path} ${response.status}`);
    return response;
  }

  /**
   * Sends one Admin API request and returns its status and parsed body, whatever the status; a 401 is retried once
   * with a fresh token. `path` starts with `/admin/`.
   */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<AdminResponse<T>> {
    if (!path.startsWith("/admin/")) throw new Error(`not an Admin API path: ${path}`);
    let response = await this.#send(method, path, this.#token ?? (await this.#freshToken()), body);
    if (response.status === 401) {
      await response.body?.cancel();
      response = await this.#send(method, path, await this.#freshToken(), body);
    }
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed as T, location: response.headers.get("location") };
  }

  /** GET that expects 200, or returns undefined on 404. */
  async find<T>(path: string): Promise<T | undefined> {
    const response = await this.request<T>("GET", path);
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw new KeycloakAdminError("GET", path, response.status);
    return response.body;
  }

  /** GET that expects 200. */
  async get<T>(path: string): Promise<T> {
    const response = await this.request<T>("GET", path);
    if (response.status !== 200) throw new KeycloakAdminError("GET", path, response.status);
    return response.body;
  }

  /** Sends a write and requires one of the expected statuses, 2xx by default. */
  async write(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown, expected?: readonly number[]) {
    const response = await this.request(method, path, body);
    const ok = expected === undefined ? response.status >= 200 && response.status < 300 : expected.includes(response.status);
    if (!ok) throw new KeycloakAdminError(method, path, response.status);
    return response;
  }
}
