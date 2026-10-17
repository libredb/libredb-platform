// The OIDC checks of `verify`: Studio's login redirect chain to Keycloak without credentials, and
// the issuer's discovery document as each app fetches it from inside the app network with its own env file, so its
// proxy settings, NO_PROXY and CA bundle apply as they do for the app itself.
import { z } from "zod";
import { APP_CLIENT_IDS } from "../keycloak/desired";
import type { Check } from "./catalogue";
import { failed, PASSED, probe, probeScript, type ProbeRunner } from "./platform";
import { STUDIO_LOG_HINT } from "./studio";

/** One app's discovery probe: its own image and its own env file. */
export interface DiscoveryProbe {
  /** The app as the cause names it, such as Platform or Studio. */
  app: string;
  probe: ProbeRunner;
  envFile: string;
}

export interface OidcCheckContext {
  /** Runs probe scripts on the edge network, which holds every public hostname as an alias of the edge. */
  probe: ProbeRunner;
  /** Studio's public base URL, such as https://studio.example.com. */
  studioUrl: string;
  /** The issuer both apps sign in with, `https://<auth>/realms/<realm>`. */
  issuer: string;
  /** The redirect URI of client libredb-studio, `https://<studio>/api/auth/oidc/callback`. */
  studioRedirectUri: string;
  discovery: readonly DiscoveryProbe[];
}

type OidcChecks = { oidc: OidcCheckContext };

/** The route that GET /login sends a signed-out browser to when OIDC_AUTO_REDIRECT is on. */
const OIDC_LOGIN_PATH = "/api/auth/oidc/login";

// GET /login, then its Location, then the authorization endpoint when that is where Studio sent the browser. Every
// request is made without following redirects, so the script sees each hop.
const CHAIN_SCRIPT = probeScript(
  "oidc-chain",
  [
    "  const base = process.env.PROBE_STUDIO_URL;",
    '  const login = await fetch(base + "/login", { redirect: "manual", signal: timeout() });',
    "  result.loginStatus = login.status;",
    '  result.loginLocation = login.headers.get("location");',
    "  if (result.loginLocation !== null) {",
    '    const oidc = await fetch(new URL(result.loginLocation, base), { redirect: "manual", signal: timeout() });',
    "    result.oidcStatus = oidc.status;",
    '    result.oidcLocation = oidc.headers.get("location");',
    "    if (result.oidcLocation !== null) {",
    "      const target = new URL(result.oidcLocation, base);",
    "      if (target.origin + target.pathname === process.env.PROBE_AUTHORIZATION) {",
    '        const auth = await fetch(target, { redirect: "manual", signal: timeout() });',
    "        result.authStatus = auth.status;",
    "      }",
    "    }",
    "  }",
  ].join("\n"),
);

const chainResult = z
  .object({
    loginStatus: z.number().int().optional(),
    loginLocation: z.string().nullable().optional(),
    oidcStatus: z.number().int().optional(),
    oidcLocation: z.string().nullable().optional(),
    authStatus: z.number().int().optional(),
    error: z.string().optional(),
  })
  .strict();

/** What a redirect to /login?error=<code> of Studio's OIDC login route means. */
function loginErrorMeaning(code: string, issuer: string): string {
  if (code === "oidc_config") return "Studio's OIDC configuration is invalid";
  if (code === "oidc_discovery") return `Studio cannot reach or trust the issuer ${issuer}`;
  if (code === "oidc_failed") return "Studio's OIDC login failed after discovery";
  return "Studio refused the login";
}

/**
 * studio-oidc-chain: from a probe container on the edge network, GET https://<studio>/login leads to
 * /api/auth/oidc/login, which answers 307 to the issuer's authorization endpoint for client libredb-studio with the
 * exact redirect_uri and no prompt parameter (OIDC_PROMPT=omit), and that endpoint answers 200.
 */
export const studioOidcChainCheck: Check<OidcChecks> = {
  id: "studio-oidc-chain",
  async run({ oidc }) {
    const authorization = `${oidc.issuer}/protocol/openid-connect/auth`;
    const result = await probe(
      oidc,
      "oidc-chain",
      { script: CHAIN_SCRIPT, env: { PROBE_STUDIO_URL: oidc.studioUrl, PROBE_AUTHORIZATION: authorization } },
      chainResult,
    );
    const loginUrl = `${oidc.studioUrl}/login`;
    if (result.error !== undefined) return failed(`GET ${loginUrl} failed: ${result.error}`);
    if (result.loginLocation == null) {
      return failed(
        `GET ${loginUrl} answered ${result.loginStatus}, not a redirect to ${OIDC_LOGIN_PATH}, so OIDC_AUTO_REDIRECT is off`,
      );
    }
    if (new URL(result.loginLocation, oidc.studioUrl).pathname !== OIDC_LOGIN_PATH) {
      return failed(`GET ${loginUrl} redirected to ${result.loginLocation}, not to ${OIDC_LOGIN_PATH}`);
    }
    const oidcLogin = `${oidc.studioUrl}${OIDC_LOGIN_PATH}`;
    if (result.oidcStatus !== 307 || result.oidcLocation == null) {
      return failed(`GET ${oidcLogin} answered ${result.oidcStatus}, not 307`);
    }
    const location = new URL(result.oidcLocation, oidc.studioUrl);
    const error = location.pathname === "/login" ? location.searchParams.get("error") : null;
    if (error !== null) {
      return failed(
        `GET ${oidcLogin} redirected to /login?error=${error}: ${loginErrorMeaning(error, oidc.issuer)}; ${STUDIO_LOG_HINT}`,
      );
    }
    if (`${location.origin}${location.pathname}` !== authorization) {
      return failed(`GET ${oidcLogin} redirected to ${result.oidcLocation}, not to ${authorization}`);
    }
    const clientId = location.searchParams.get("client_id");
    if (clientId !== APP_CLIENT_IDS.studio) {
      return failed(`the authorization request sends client_id ${clientId}, not ${APP_CLIENT_IDS.studio}`);
    }
    const redirectUri = location.searchParams.get("redirect_uri");
    if (redirectUri !== oidc.studioRedirectUri) {
      return failed(
        `the authorization request sends redirect_uri ${redirectUri}, and Studio's callback is ${oidc.studioRedirectUri}`,
      );
    }
    const prompt = location.searchParams.get("prompt");
    if (prompt !== null) {
      return failed(`the authorization request sends prompt=${prompt}, and OIDC_PROMPT=omit sends none`);
    }
    if (result.authStatus !== 200) return failed(`GET ${authorization} answered ${result.authStatus}, not 200`);
    return PASSED;
  },
};

const DISCOVERY_SCRIPT = probeScript(
  "discovery",
  [
    "  const response = await fetch(process.env.PROBE_URL, { signal: timeout() });",
    "  result.status = response.status;",
    "  if (response.status === 200) result.issuer = (await response.json()).issuer;",
  ].join("\n"),
);

const discoveryResult = z
  .object({ status: z.number().int().optional(), issuer: z.unknown().optional(), error: z.string().optional() })
  .strict();

/**
 * oidc-discovery-in-network: the Platform and Studio images, each with its own env file, fetch
 * <issuer>/.well-known/openid-configuration from the app network and receive exactly the configured issuer.
 */
export const oidcDiscoveryInNetworkCheck: Check<OidcChecks> = {
  id: "oidc-discovery-in-network",
  async run({ oidc }) {
    const url = `${oidc.issuer}/.well-known/openid-configuration`;
    const problems: string[] = [];
    for (const app of oidc.discovery) {
      const request = { script: DISCOVERY_SCRIPT, env: { PROBE_URL: url }, envFile: app.envFile };
      const result = await probe(app, "discovery", request, discoveryResult);
      if (result.error !== undefined) problems.push(`${app.app} could not fetch ${url}: ${result.error}`);
      else if (result.status !== 200) problems.push(`${app.app}'s GET ${url} answered ${result.status}`);
      else if (result.issuer !== oidc.issuer) {
        problems.push(
          `${app.app}'s discovery document ${url} names issuer ${String(result.issuer)}, and the configured issuer is ${oidc.issuer}`,
        );
      }
    }
    return problems.length === 0 ? PASSED : failed(problems.join("; "));
  },
};

/** The OIDC checks, in the order verify runs them. */
export const OIDC_CHECKS: readonly Check<OidcChecks>[] = [studioOidcChainCheck, oidcDiscoveryInNetworkCheck];
