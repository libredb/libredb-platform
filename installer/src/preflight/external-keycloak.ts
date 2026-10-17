// The preflight of an external Keycloak whose realm the installer reuses:
// evaluates what the step observed against the release. Every problem is collected, so one run names everything the
// customer has to fix, and a refusal exits 3.
import { PLATFORM_ENV } from "../contracts/platform";
import { PAIRWISE_CONSEQUENCE, pairwiseFindings } from "../keycloak/planner";
import type { ReleaseManifest } from "../release/manifest";
import { clockSkewProblem } from "../verify/host";
import { compareVersions, isVersion, PreflightError } from "./docker-checks";

/** The oldest Keycloak whose client role mapper has the introspection flag that client scope libredb-roles sets. */
export const MINIMUM_KEYCLOAK = "25.0.0";

/** The oldest Keycloak a release is tested with; an older one that passes the minimum is untested. */
const TESTED_MAJOR = "26.0.0";

/** What the admin credential read from the Admin API. */
export interface AdminFindings {
  /** Keycloak's clock, the `iat` of the admin token, and the installer clock halfway through its request, in epoch ms. */
  clock: { keycloakMs: number; installerMs: number };
  /** `systemInfo.version` of GET /admin/serverinfo. */
  version: string;
  /** The realm's SSO Session Idle in seconds, or null when the realm does not exist. */
  realm: { ssoSessionIdleTimeout: number } | null;
  /** The protocol mappers of each app client that exists in the realm. */
  appClients: { clientId: string; mappers: { name: string; protocolMapper: string }[] }[];
}

export interface ExternalKeycloakObservation {
  /** The issuer both apps trust, `<keycloak.external.baseUrl>/realms/<realm>`. */
  issuer: string;
  realm: string;
  /** Where the installer reaches the Admin API: keycloak.external.adminUrl, or the base URL. */
  adminUrl: string;
  /** keycloak.external.caBundleFile, which the installer and both apps trust besides the system roots. */
  caBundleFile: string | undefined;
  /** The answer to GET <issuer>/.well-known/openid-configuration, or why there was none, such as a TLS error. */
  discovery: { status: number; issuer: string | undefined } | { error: string };
  /**
   * What the admin credential read, why that failed, the note of a run that skipped it, or `manual` when the site
   * configures the realm and the installer has no admin credential, so keycloak-configure checks the realm instead.
   */
  admin: AdminFindings | { error: string } | { skipped: string } | { manual: true };
}

export interface ExternalKeycloakExpectations {
  /** The Keycloak version the release is tested with, such as 26.8.1. */
  testedVersion: string;
  /**
   * Platform's PLATFORM_SESSION_RECHECK_SECONDS, which the realm's SSO Session Idle must exceed, because Platform keeps
   * its Keycloak session alive only at its rechecks.
   */
  sessionRecheckSeconds: number;
}

/** The expectations of a release: its pinned Keycloak version and Platform's default session recheck. */
export function keycloakExpectations(manifest: ReleaseManifest): ExternalKeycloakExpectations {
  return {
    testedVersion: manifest.images.keycloak.version,
    sessionRecheckSeconds: Number(PLATFORM_ENV.PLATFORM_SESSION_RECHECK_SECONDS.value),
  };
}

function discoveryProblems(observed: ExternalKeycloakObservation, realmMissing: boolean): string[] {
  const url = `${observed.issuer}/.well-known/openid-configuration`;
  const { discovery } = observed;
  if ("error" in discovery) {
    const trust =
      observed.caBundleFile === undefined
        ? "the system roots, as both apps do, and keycloak.external.caBundleFile adds the CA of a private issuer"
        : `the system roots and ${observed.caBundleFile} (keycloak.external.caBundleFile), as both apps do`;
    return [`GET ${url} failed: ${discovery.error}; the installer trusts ${trust}`];
  }
  // A realm that does not exist has no discovery document, which its own problem already names.
  if (realmMissing) return [];
  if (discovery.status !== 200) return [`GET ${url} answered ${discovery.status}`];
  if (discovery.issuer === observed.issuer) return [];
  return [
    `${url} names the issuer ${discovery.issuer ?? "(none)"}, and both apps expect ${observed.issuer}; ` +
      "keycloak.external.baseUrl must be the URL that Keycloak announces",
  ];
}

function versionFinding(version: string, adminUrl: string, testedVersion: string): { problem?: string; warning?: string } {
  if (!isVersion(version)) {
    return { problem: `Keycloak at ${adminUrl} reported the version '${version}', which is not a version number` };
  }
  if (compareVersions(version, MINIMUM_KEYCLOAK) < 0) {
    return {
      problem:
        `Keycloak ${version} at ${adminUrl} is older than 25, the first version whose client role mapper has the ` +
        "introspection flag that client scope libredb-roles sets",
    };
  }
  if (compareVersions(version, TESTED_MAJOR) < 0) {
    return { warning: `Keycloak ${version} at ${adminUrl} is untested: this release is tested with Keycloak ${testedVersion}` };
  }
  return {};
}

/**
 * Throws PreflightError naming every problem of the external Keycloak: an issuer the installer cannot reach or trust,
 * a discovery document that names another issuer, an admin credential that fails, a realm that does not exist, a
 * Keycloak older than 25, a pairwise subject mapper on an app client, or a clock more than 15 s away. Returns the
 * warnings: a Keycloak 25, an SSO Session Idle that is not longer than Platform's session recheck, or the note of a
 * run that skipped the checks that need the admin credential.
 */
export function checkExternalKeycloak(
  observed: ExternalKeycloakObservation,
  expectations: ExternalKeycloakExpectations,
): string[] {
  const { admin, adminUrl, realm } = observed;
  const problems: string[] = [];
  const warnings: string[] = [];
  problems.push(...discoveryProblems(observed, "realm" in admin && admin.realm === null));
  if ("manual" in admin) {
    // keycloak-configure checks the realm with the two client secrets (keycloak.external.provisioning manual).
  } else if ("skipped" in admin) {
    warnings.push(admin.skipped);
  } else if ("error" in admin) {
    problems.push(`the checks that need the Keycloak admin credential failed: ${admin.error}`);
  } else {
    if (admin.realm === null) {
      problems.push(
        `realm ${realm} does not exist on ${adminUrl}; keycloak.realm must name an existing realm, because the ` +
          "installer reuses it and never creates one",
      );
    }
    const version = versionFinding(admin.version, adminUrl, expectations.testedVersion);
    if (version.problem !== undefined) problems.push(version.problem);
    if (version.warning !== undefined) warnings.push(version.warning);
    for (const client of admin.appClients) {
      problems.push(...pairwiseFindings(client.clientId, client.mappers).map((finding) => `${finding}, ${PAIRWISE_CONSEQUENCE}; remove the mapper`));
    }
    const what = `the Keycloak clock (iat of a token from ${adminUrl})`;
    const skew = clockSkewProblem(what, admin.clock.keycloakMs, admin.clock.installerMs);
    if (skew !== undefined) problems.push(skew);
    const recheck = expectations.sessionRecheckSeconds;
    if (admin.realm !== null && admin.realm.ssoSessionIdleTimeout <= recheck) {
      warnings.push(
        `realm ${realm} has an SSO Session Idle of ${admin.realm.ssoSessionIdleTimeout} s, not longer than Platform's ` +
          `session recheck of ${recheck} s, so a Platform session ends while its user is idle between two rechecks; ` +
          "ask the realm's administrators to raise it",
      );
    }
  }
  if (problems.length > 0) throw new PreflightError(problems);
  return warnings;
}
