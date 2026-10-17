import { describe, expect, test } from "bun:test";
import { ExitCode } from "../../../src/cli/exit-codes";
import { PreflightError } from "../../../src/preflight/docker-checks";
import {
  checkExternalKeycloak,
  keycloakExpectations,
  type AdminFindings,
  type ExternalKeycloakObservation,
} from "../../../src/preflight/external-keycloak";
import { manifestFixture } from "../release/fixture";

const ISSUER = "https://sso.corp.test/realms/corp";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const EXPECTATIONS = { testedVersion: "26.8.1", sessionRecheckSeconds: 300 };

function findings(overrides: Partial<AdminFindings> = {}): AdminFindings {
  return {
    clock: { keycloakMs: NOW, installerMs: NOW + 400 },
    version: "26.8.1",
    realm: { ssoSessionIdleTimeout: 1800 },
    appClients: [
      { clientId: "libredb-studio", mappers: [] },
      { clientId: "libredb-platform", mappers: [{ name: "audience", protocolMapper: "oidc-audience-mapper" }] },
    ],
    ...overrides,
  };
}

function observation(overrides: Partial<ExternalKeycloakObservation> = {}): ExternalKeycloakObservation {
  return {
    issuer: ISSUER,
    realm: "corp",
    adminUrl: "https://sso.corp.test",
    caBundleFile: "/etc/pki/corp-ca.pem",
    discovery: { status: 200, issuer: ISSUER },
    admin: findings(),
    ...overrides,
  };
}

function refusal(observed: ExternalKeycloakObservation): PreflightError {
  try {
    checkExternalKeycloak(observed, EXPECTATIONS);
  } catch (error) {
    if (error instanceof PreflightError) return error;
    throw error;
  }
  throw new Error("the preflight passed");
}

describe("checkExternalKeycloak", () => {
  test("a server older than Keycloak 25 is refused with exit 3 and a 25.x server warns as untested", () => {
    const error = refusal(observation({ admin: findings({ version: "24.0.5" }) }));
    expect(error.exitCode).toBe(ExitCode.PreflightFailed);
    expect(error.exitCode).toBe(3);
    expect(error.problems).toEqual([
      "Keycloak 24.0.5 at https://sso.corp.test is older than 25, the first version whose client role mapper has the " +
        "introspection flag that client scope libredb-roles sets",
    ]);

    expect(checkExternalKeycloak(observation({ admin: findings({ version: "25.0.6" }) }), EXPECTATIONS)).toEqual([
      "Keycloak 25.0.6 at https://sso.corp.test is untested: this release is tested with Keycloak 26.8.1",
    ]);
    for (const version of ["26.8.1", "26.0.15.redhat-00001", "27.0.0"]) {
      expect(checkExternalKeycloak(observation({ admin: findings({ version }) }), EXPECTATIONS)).toEqual([]);
    }
  });

  test("a version that is not a version number is refused naming it", () => {
    expect(refusal(observation({ admin: findings({ version: "nightly" }) })).problems).toEqual([
      "Keycloak at https://sso.corp.test reported the version 'nightly', which is not a version number",
    ]);
  });

  test("a realm that does not exist is refused, because the installer reuses a realm and never creates one", () => {
    const error = refusal(
      observation({ discovery: { status: 404, issuer: undefined }, admin: findings({ realm: null, appClients: [] }) }),
    );
    expect(error.problems).toEqual([
      "realm corp does not exist on https://sso.corp.test; keycloak.realm must name an existing realm, because the " +
        "installer reuses it and never creates one",
    ]);
  });

  test("a pairwise subject mapper on either app client is refused naming the client and the mapper", () => {
    const appClients = [
      { clientId: "libredb-studio", mappers: [{ name: "pairwise", protocolMapper: "oidc-sha256-pairwise-sub-mapper" }] },
      { clientId: "libredb-platform", mappers: [] },
    ];
    const error = refusal(observation({ admin: findings({ appClients }) }));
    expect(error.exitCode).toBe(3);
    expect(error.problems).toEqual([
      "client libredb-studio has the mapper pairwise of type oidc-sha256-pairwise-sub-mapper, which would change the " +
        "sub claim that Studio and Platform key every user by; remove the mapper",
    ]);
  });

  test("an issuer the installer cannot reach or trust is refused naming the trust it used", () => {
    expect(refusal(observation({ discovery: { error: "self signed certificate in certificate chain" } })).problems).toEqual([
      `GET ${ISSUER}/.well-known/openid-configuration failed: self signed certificate in certificate chain; the ` +
        "installer trusts the system roots and /etc/pki/corp-ca.pem (keycloak.external.caBundleFile), as both apps do",
    ]);
    expect(
      refusal(observation({ caBundleFile: undefined, discovery: { error: "unable to get local issuer certificate" } })).problems,
    ).toEqual([
      `GET ${ISSUER}/.well-known/openid-configuration failed: unable to get local issuer certificate; the installer ` +
        "trusts the system roots, as both apps do, and keycloak.external.caBundleFile adds the CA of a private issuer",
    ]);
  });

  test("a discovery document that fails or names another issuer is refused", () => {
    expect(refusal(observation({ discovery: { status: 503, issuer: undefined } })).problems).toEqual([
      `GET ${ISSUER}/.well-known/openid-configuration answered 503`,
    ]);
    expect(
      refusal(observation({ discovery: { status: 200, issuer: "https://sso.corp.test:8443/realms/corp" } })).problems,
    ).toEqual([
      `${ISSUER}/.well-known/openid-configuration names the issuer https://sso.corp.test:8443/realms/corp, and both apps ` +
        `expect ${ISSUER}; keycloak.external.baseUrl must be the URL that Keycloak announces`,
    ]);
  });

  test("a Keycloak clock more than 15 s away from the installer clock is refused naming both clocks", () => {
    const clock = { keycloakMs: NOW, installerMs: NOW + 16_000 };
    expect(refusal(observation({ admin: findings({ clock }) })).problems).toEqual([
      "the Keycloak clock (iat of a token from https://sso.corp.test) reads 2026-10-15T12:00:00.000Z and the installer " +
        "clock 2026-10-15T12:00:16.000Z, 16.0 s apart, and the limit is 15 s",
    ]);
  });

  test("an SSO Session Idle that is not longer than Platform's session recheck warns", () => {
    expect(checkExternalKeycloak(observation({ admin: findings({ realm: { ssoSessionIdleTimeout: 300 } }) }), EXPECTATIONS)).toEqual([
      "realm corp has an SSO Session Idle of 300 s, not longer than Platform's session recheck of 300 s, so a Platform " +
        "session ends while its user is idle between two rechecks; ask the realm's administrators to raise it",
    ]);
    expect(checkExternalKeycloak(observation({ admin: findings({ realm: { ssoSessionIdleTimeout: 301 } }) }), EXPECTATIONS)).toEqual(
      [],
    );
  });

  test("a refused admin credential fails, and a skipped admin check passes with its note", () => {
    const refused = "Keycloak refused the password of user admin for client admin-cli in realm master with 401";
    expect(refusal(observation({ admin: { error: refused } })).problems).toEqual([
      `the checks that need the Keycloak admin credential failed: ${refused}`,
    ]);
    const note = "the preflight of the external Keycloak: skipped, because keycloak.external.adminPasswordEnv names X, which is not set";
    expect(checkExternalKeycloak(observation({ admin: { skipped: note } }), EXPECTATIONS)).toEqual([note]);
  });

  test("a realm the site configures leaves the admin checks to keycloak-configure, and still checks discovery", () => {
    expect(checkExternalKeycloak(observation({ admin: { manual: true } }), EXPECTATIONS)).toEqual([]);
    expect(refusal(observation({ admin: { manual: true }, discovery: { status: 404, issuer: undefined } })).problems).toEqual([
      `GET ${ISSUER}/.well-known/openid-configuration answered 404`,
    ]);
  });

  test("a release expects its pinned Keycloak and Platform's default session recheck of 300 s", () => {
    const manifest = manifestFixture();
    expect(keycloakExpectations(manifest)).toEqual({
      testedVersion: manifest.images.keycloak.version,
      sessionRecheckSeconds: 300,
    });
  });

  test("every problem is named in one refusal", () => {
    const error = refusal(
      observation({
        discovery: { status: 200, issuer: "https://elsewhere.test/realms/corp" },
        admin: findings({
          version: "22.0.0",
          clock: { keycloakMs: NOW, installerMs: NOW - 60_000 },
          appClients: [
            { clientId: "libredb-studio", mappers: [] },
            { clientId: "libredb-platform", mappers: [{ name: "p", protocolMapper: "oidc-sha256-pairwise-sub-mapper" }] },
          ],
        }),
      }),
    );
    expect(error.problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual([
      `${ISSUER}/.well-known/openid-configuration names`,
      "Keycloak 22.0.0",
      "client libredb-platform",
      "the Keycloak",
    ]);
  });
});
