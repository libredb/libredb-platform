import { describe, expect, test } from "bun:test";
import {
  OIDC_CHECKS,
  oidcDiscoveryInNetworkCheck,
  studioOidcChainCheck,
  type OidcCheckContext,
} from "../../../src/verify/oidc-chain";
import type { ProbeRequest, ProbeResult } from "../../../src/verify/platform";

const STUDIO_URL = "https://studio.example.com";
const ISSUER = "https://auth.example.com/realms/libredb";
const REDIRECT_URI = `${STUDIO_URL}/api/auth/oidc/callback`;
const AUTHORIZATION = `${ISSUER}/protocol/openid-connect/auth`;

const line = (name: string, value: unknown) => `libredb-result ${name} ${JSON.stringify(value)}\n`;
const ok = (stdout: string): ProbeResult => ({ exitCode: 0, stdout, stderr: "" });

class FakeProbe {
  readonly requests: ProbeRequest[] = [];
  readonly #results: ProbeResult[];

  constructor(...results: ProbeResult[]) {
    this.#results = results;
  }

  async run(request: ProbeRequest): Promise<ProbeResult> {
    this.requests.push(request);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("the fake probe has no more results");
    return result;
  }
}

function context(overrides: Partial<OidcCheckContext> = {}): { oidc: OidcCheckContext } {
  return {
    oidc: {
      probe: new FakeProbe(),
      studioUrl: STUDIO_URL,
      issuer: ISSUER,
      studioRedirectUri: REDIRECT_URI,
      discovery: [],
      ...overrides,
    },
  };
}

const authorize = (params: Record<string, string>) => `${AUTHORIZATION}?${new URLSearchParams(params).toString()}`;

const chain = (oidcLocation: string | null, extra: Record<string, unknown> = {}) =>
  ok(
    line("oidc-chain", {
      loginStatus: 307,
      loginLocation: "/api/auth/oidc/login",
      oidcStatus: 307,
      oidcLocation,
      ...extra,
    }),
  );

describe("studio-oidc-chain", () => {
  test("a 307 to /login?error=oidc_discovery is reported as 'Studio cannot reach or trust the issuer'", async () => {
    const probe = new FakeProbe(chain(`${STUDIO_URL}/login?error=oidc_discovery`));
    expect(await studioOidcChainCheck.run(context({ probe }))).toEqual({
      passed: false,
      cause:
        `GET ${STUDIO_URL}/api/auth/oidc/login redirected to /login?error=oidc_discovery: ` +
        `Studio cannot reach or trust the issuer ${ISSUER}; the Studio log has the full message: docker compose -p libredb logs studio`,
    });
  });

  test("oidc_config and oidc_failed name a configuration error and a failure after discovery", async () => {
    const config = new FakeProbe(chain(`${STUDIO_URL}/login?error=oidc_config`));
    expect(await studioOidcChainCheck.run(context({ probe: config }))).toEqual({
      passed: false,
      cause:
        `GET ${STUDIO_URL}/api/auth/oidc/login redirected to /login?error=oidc_config: ` +
        "Studio's OIDC configuration is invalid; the Studio log has the full message: docker compose -p libredb logs studio",
    });
    const failed = new FakeProbe(chain(`${STUDIO_URL}/login?error=oidc_failed`));
    expect(await studioOidcChainCheck.run(context({ probe: failed }))).toEqual({
      passed: false,
      cause:
        `GET ${STUDIO_URL}/api/auth/oidc/login redirected to /login?error=oidc_failed: ` +
        "Studio's OIDC login failed after discovery; the Studio log has the full message: docker compose -p libredb logs studio",
    });
    const other = new FakeProbe(chain(`${STUDIO_URL}/login?error=oidc_no_role`));
    expect(await studioOidcChainCheck.run(context({ probe: other }))).toEqual({
      passed: false,
      cause:
        `GET ${STUDIO_URL}/api/auth/oidc/login redirected to /login?error=oidc_no_role: ` +
        "Studio refused the login; the Studio log has the full message: docker compose -p libredb logs studio",
    });
  });

  test("passes on 307 to the authorization endpoint for libredb-studio with the exact redirect_uri, no prompt, and a 200 there", async () => {
    const location = authorize({ client_id: "libredb-studio", redirect_uri: REDIRECT_URI, response_type: "code" });
    const probe = new FakeProbe(chain(location, { authStatus: 200 }));
    expect(await studioOidcChainCheck.run(context({ probe }))).toEqual({ passed: true });
    expect(probe.requests[0]?.env).toEqual({ PROBE_STUDIO_URL: STUDIO_URL, PROBE_AUTHORIZATION: AUTHORIZATION });
    expect(probe.requests[0]?.envFile).toBeUndefined();
  });

  test("names each broken link of the chain", async () => {
    const good = { client_id: "libredb-studio", redirect_uri: REDIRECT_URI, response_type: "code" };
    const cases: [ProbeResult, string][] = [
      [ok(line("oidc-chain", { error: "TypeError: fetch failed" })), `GET ${STUDIO_URL}/login failed: TypeError: fetch failed`],
      [
        ok(line("oidc-chain", { loginStatus: 200, loginLocation: null })),
        `GET ${STUDIO_URL}/login answered 200, not a redirect to /api/auth/oidc/login, so OIDC_AUTO_REDIRECT is off`,
      ],
      [
        ok(line("oidc-chain", { loginStatus: 307, loginLocation: "/admin" })),
        `GET ${STUDIO_URL}/login redirected to /admin, not to /api/auth/oidc/login`,
      ],
      [
        chain(null, { oidcStatus: 500 }),
        `GET ${STUDIO_URL}/api/auth/oidc/login answered 500, not 307`,
      ],
      [chain(`https://evil.example.com/auth?client_id=libredb-studio`), `GET ${STUDIO_URL}/api/auth/oidc/login redirected to https://evil.example.com/auth?client_id=libredb-studio, not to ${AUTHORIZATION}`],
      [
        chain(authorize({ ...good, client_id: "libredb-platform" })),
        `the authorization request sends client_id libredb-platform, not libredb-studio`,
      ],
      [
        chain(authorize({ ...good, redirect_uri: "https://localhost:3000/api/auth/oidc/callback" })),
        `the authorization request sends redirect_uri https://localhost:3000/api/auth/oidc/callback, and Studio's callback is ${REDIRECT_URI}`,
      ],
      [
        chain(authorize({ ...good, prompt: "login" }), { authStatus: 200 }),
        "the authorization request sends prompt=login, and OIDC_PROMPT=omit sends none",
      ],
      [chain(authorize(good), { authStatus: 400 }), `GET ${AUTHORIZATION} answered 400, not 200`],
    ];
    for (const [result, cause] of cases) {
      const probe = new FakeProbe(result);
      expect(await studioOidcChainCheck.run(context({ probe }))).toEqual({ passed: false, cause });
    }
  });
});

describe("oidc-discovery-in-network", () => {
  test("a discovery document whose issuer differs from the configured one fails oidc-discovery-in-network naming both", async () => {
    const platform = new FakeProbe(ok(line("discovery", { status: 200, issuer: ISSUER })));
    const studio = new FakeProbe(ok(line("discovery", { status: 200, issuer: "https://auth.example.com:8443/realms/libredb" })));
    const outcome = await oidcDiscoveryInNetworkCheck.run(
      context({
        discovery: [
          { app: "Platform", probe: platform, envFile: "/opt/libredb/env/platform.env" },
          { app: "Studio", probe: studio, envFile: "/opt/libredb/env/studio.env" },
        ],
      }),
    );
    expect(outcome).toEqual({
      passed: false,
      cause:
        `Studio's discovery document ${ISSUER}/.well-known/openid-configuration names issuer ` +
        `https://auth.example.com:8443/realms/libredb, and the configured issuer is ${ISSUER}`,
    });
    // Each app's own image fetches with its own env file, so its proxy settings apply.
    expect(platform.requests[0]?.envFile).toBe("/opt/libredb/env/platform.env");
    expect(studio.requests[0]?.envFile).toBe("/opt/libredb/env/studio.env");
    expect(studio.requests[0]?.env).toEqual({ PROBE_URL: `${ISSUER}/.well-known/openid-configuration` });
  });

  test("passes when both apps receive the configured issuer, and names a failed fetch or status", async () => {
    const good = () => new FakeProbe(ok(line("discovery", { status: 200, issuer: ISSUER })));
    const apps = (platform: FakeProbe, studio: FakeProbe) => [
      { app: "Platform", probe: platform, envFile: "/p.env" },
      { app: "Studio", probe: studio, envFile: "/s.env" },
    ];
    expect(await oidcDiscoveryInNetworkCheck.run(context({ discovery: apps(good(), good()) }))).toEqual({ passed: true });

    const refused = new FakeProbe(ok(line("discovery", { error: "Error: connect ECONNREFUSED 127.0.0.1:3128" })));
    const missing = new FakeProbe(ok(line("discovery", { status: 404 })));
    expect(await oidcDiscoveryInNetworkCheck.run(context({ discovery: apps(refused, missing) }))).toEqual({
      passed: false,
      cause:
        `Platform could not fetch ${ISSUER}/.well-known/openid-configuration: Error: connect ECONNREFUSED 127.0.0.1:3128; ` +
        `Studio's GET ${ISSUER}/.well-known/openid-configuration answered 404`,
    });
  });
});

test("the OIDC checks run in the order chain, discovery", () => {
  expect(OIDC_CHECKS.map((check) => check.id)).toEqual(["studio-oidc-chain", "oidc-discovery-in-network"]);
});
