import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/load";
import type { DockerInstallation } from "../../../src/config/schema";
import { computeDesired } from "../../../src/model/desired";
import { renderCompose } from "../../../src/render/compose";
import { formatReport, type ReportInput } from "../../../src/steps/report";
import { runningServices } from "../../../src/steps/verify";
import { runChecks } from "../../../src/verify/catalogue";
import { platformLicenseCheck } from "../../../src/verify/platform-license";
import { EXTERNAL_KEYCLOAK_SETS } from "../keycloak/fixture";
import { manifestFixture } from "../release/fixture";
import { TRUST_FIXTURE } from "../render/fixture";

const CONFIG = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker.yaml");
const PORTS_CONFIG = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-ports.yaml");
const PROVIDED_CONFIG = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-provided.yaml");
const EXTERNAL_TLS_CONFIG = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-external-tls.yaml");

function input(overrides: Partial<ReportInput> = {}, sets: string[] = [], file = CONFIG): ReportInput {
  const config = loadConfig({ file, sets }) as DockerInstallation;
  return {
    desired: computeDesired(config, manifestFixture()),
    config,
    configFile: "libredb.yaml",
    caBundleFile: "/opt/libredb/ca/ca.crt",
    passwordFiles: { "first-admin": "/opt/libredb/secrets/first-admin.txt", "user-manager": "/opt/libredb/secrets/user-manager.txt" },
    results: [{ id: "studio-ready", result: "passed", cause: null }],
    warnings: [],
    ...overrides,
  };
}

describe("formatReport", () => {
  test("prints the three URLs, the CA bundle, the password files and the next steps", () => {
    const text = formatReport(input());
    expect(text).toContain("LibreDB is installed and every verify check passed.");
    for (const expected of [
      "  Platform  https://platform.libredb.test",
      "  Studio    https://studio.libredb.test",
      "  Auth      https://auth.libredb.test",
      "CA bundle: /opt/libredb/ca/ca.crt",
      "  First LibreDB admin libredb-admin: /opt/libredb/secrets/first-admin.txt",
      "  Keycloak user manager libredb-user-manager: /opt/libredb/secrets/user-manager.txt",
      "Run 'libredb-installer keycloak console -c libredb.yaml' and sign in as libredb-user-manager",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("Warnings:");
    expect(text).not.toContain("ports style");
  });

  test("in tls.mode generated the first next step adds the internal CA, which tls export-ca writes, to every browser", () => {
    expect(formatReport(input())).toContain(
      "Next steps:\n" +
        "  1. Run 'libredb-installer tls export-ca -o ca.crt' and add ca.crt, the internal CA, to the trust store of every " +
        "browser and client that opens the URLs above.\n",
    );
  });

  test("in tls.mode provided and external the first next step names the customer's CA instead of the internal CA", () => {
    const provided = formatReport(input({}, [], PROVIDED_CONFIG));
    expect(provided).toContain(
      "Next steps:\n" +
        "  1. Make sure every browser and client that opens the URLs above trusts the CA in " +
        "/var/lib/libredb-e2e/tls-modes/ca.crt, which the certificates of tls.provided chain to; they do not need the " +
        "internal CA.\n",
    );
    const external = formatReport(input({}, [], EXTERNAL_TLS_CONFIG));
    expect(external).toContain(
      "Next steps:\n" +
        "  1. Make sure every browser and client that opens the URLs above trusts the CA in " +
        "/var/lib/libredb-e2e/tls-modes/ca.crt, which the certificates of your TLS proxy chain to; they do not need the " +
        "internal CA.\n",
    );
    for (const text of [provided, external]) expect(text).not.toContain("tls export-ca");
  });

  test("the ports style prints the URLs with their ports and warns that a compromise of one app reaches the sessions of the others", () => {
    const text = formatReport(input({}, [], PORTS_CONFIG));
    for (const expected of [
      "  Platform  https://lab.libredb.test\n",
      "  Studio    https://lab.libredb.test:8443\n",
      "  Auth      https://lab.libredb.test:9443\n",
      "\nEndpoint style: the ports style serves Platform, Studio and Keycloak on one host, lab.libredb.test, so the apps " +
        "share cookies and HSTS, which browsers scope by host and not by port.\n" +
        "Each app's server receives the cookies of the others, and script on one app can set cookies that the others " +
        "read, so a compromise of one app reaches the sessions of the others.\n" +
        "The ports style is a documented downgrade from separate hostnames, for sites where DNS is impossible.\n",
    ]) {
      expect(text).toContain(expected);
    }
  });

  test("names each failed check with its cause, points to the Studio log, and prints the recorded warnings", () => {
    const text = formatReport(
      input({
        results: [
          { id: "studio-ready", result: "failed", cause: "GET http://studio:3000/api/ready answered 503 with status misconfigured, not ok: bridge.grants_v1: 42501" },
          { id: "clock-skew", result: "passed", cause: null },
        ],
        warnings: ["libredb_backup was not created"],
      }),
    );
    expect(text).toContain("LibreDB is installed, but 1 of 2 verify checks failed:");
    expect(text).toContain("  studio-ready: GET http://studio:3000/api/ready answered 503 with status misconfigured");
    expect(text).toContain("docker compose -p libredb logs studio");
    expect(text).toContain("Warnings:\n  - libredb_backup was not created\n");
  });

  test("a check that warned is listed with the recorded warnings, and every check still counts as passed", () => {
    const text = formatReport(
      input({
        results: [
          { id: "clock-skew", result: "passed", cause: null },
          { id: "admin-mfa", result: "warning", cause: "1 account holds libredb:admin or manage-users without an OTP credential" },
        ],
        warnings: ["libredb_backup was not created"],
      }),
    );
    expect(text).toContain("LibreDB is installed and every verify check passed.");
    expect(text).toContain(
      "Warnings:\n  - verify admin-mfa: 1 account holds libredb:admin or manage-users without an OTP credential\n" +
        "  - libredb_backup was not created\n",
    );
  });

  test("leaves out the user manager when it is disabled", () => {
    const text = formatReport(input({}, ["keycloak.userManager.enabled=false"]));
    expect(text).not.toContain("user-manager.txt");
    expect(text).toContain("3. Delete the temporary password file once the first admin has set its own password.");
  });

  test("an external Keycloak prints its base URL and leaves the realm's users to its administrators", () => {
    const text = formatReport(input({}, [...EXTERNAL_KEYCLOAK_SETS, "keycloak.realm=corp"]));
    expect(text).toContain("  Auth      https://auth.libredb.test\n");
    expect(text).not.toContain("Temporary passwords:");
    expect(text).toContain(
      "Next steps:\n" +
        "  1. Run 'libredb-installer tls export-ca -o ca.crt' and add ca.crt, the internal CA, to the trust store of every " +
        "browser and client that opens the URLs above.\n" +
        "  2. Ask the administrators of realm corp to give each LibreDB user the role admin or user of client libredb, " +
        "directly or through a group.\n",
    );
  });

  test("an external Keycloak's accounts appear only when the configuration asks for them", () => {
    const sets = [...EXTERNAL_KEYCLOAK_SETS, "keycloak.realm=corp", "keycloak.external.adminUrl=https://sso-admin.corp.test"];
    const manager = formatReport(input({}, [...sets, "keycloak.userManager.enabled=true"]));
    expect(manager).toContain("Temporary passwords:\n  Keycloak user manager libredb-user-manager: /opt/libredb/secrets/user-manager.txt\n");
    expect(manager).toContain(
      "  2. Sign in to https://sso-admin.corp.test/admin/corp/console/ as libredb-user-manager to create users and give " +
        "them libredb:admin or libredb:user.\n",
    );
    expect(manager).toContain("  4. Delete the temporary password file once the user manager has set its own password.\n");
    const admin = formatReport(input({}, [...sets, "keycloak.firstAdmin.enabled=true"]));
    expect(admin).toContain("  2. Sign in to Platform as libredb-admin with the temporary password;");
    expect(admin).toContain("  4. Delete the temporary password file once the first admin has set its own password.\n");
  });
});

describe("the license in the report", () => {
  const FILE = "/etc/libredb/platform.license";
  // The start lines as Platform's logger prints them in production (src/shared/lib/license/install-license.ts).
  const ACTIVE =
    '{"level":"info","message":"License active","timestamp":"2026-10-17T10:00:01.383Z","state":"active",' +
    '"licenseId":"LDL-2026-0001","customer":"Acme Corp","expiresAt":"2027-10-16T00:00:00.000Z"}';
  const INVALID =
    '{"level":"warn","message":"License invalid, no seat can be added","timestamp":"2026-10-17T10:00:01.383Z",' +
    '"state":"invalid","code":"LICENSE_UNKNOWN_KID"}';

  /** The result of platform-license for a Platform whose start printed `text`, at `now`. */
  const licenseResults = (text = ACTIVE, now = "2026-10-17T12:00:00.000Z") =>
    runChecks([platformLicenseCheck], {
      license: {
        licenseFile: FILE,
        platformUrl: "https://platform.libredb.test",
        startLog: async () => ({ startedAt: "2026-10-17T10:00:00.000Z", text }),
        now: () => Date.parse(now),
      },
    });

  test("a license prints its id, state and expiry after the CA bundle", async () => {
    const text = formatReport(input({ results: await licenseResults() }));
    expect(text).toContain("LibreDB is installed and every verify check passed.");
    expect(text).toContain(
      "CA bundle: /opt/libredb/ca/ca.crt\nLicense: LDL-2026-0001 for Acme Corp, active, expires at 2027-10-16T00:00:00.000Z\n",
    );
  });

  test("an invalid token fails platform-license, and the report names its code and that no seat can be added", async () => {
    const text = formatReport(input({ results: await licenseResults(INVALID) }));
    expect(text).toContain(
      "LibreDB is installed, but 1 of 1 verify checks failed:\n" +
        `  platform-license: the license token in ${FILE} fails Platform's verification with LICENSE_UNKNOWN_KID, ` +
        "because a key that this Platform build does not hold signed it, so Platform adds no user, connection or admin " +
        "until a valid license is installed\n",
    );
    expect(text).toContain("License: invalid, LICENSE_UNKNOWN_KID, no seat can be added\n");
  });

  test("a license within 30 days of its expiry is listed with the warnings", async () => {
    const text = formatReport(input({ results: await licenseResults(ACTIVE, "2027-10-01T00:00:00.000Z") }));
    expect(text).toContain("License: LDL-2026-0001 for Acme Corp, expiring, expires at 2027-10-16T00:00:00.000Z\n");
    expect(text).toContain(
      "Warnings:\n  - verify platform-license: the license LDL-2026-0001 for Acme Corp expires at 2027-10-16T00:00:00.000Z, " +
        `within 30 days: renew it at info@libredb.org, replace ${FILE} with the renewed license and run apply\n`,
    );
  });

  test("a check that could not read the license leaves it unknown, and results without the check print no license", async () => {
    const results = await runChecks([platformLicenseCheck], {
      license: {
        licenseFile: FILE,
        platformUrl: "https://platform.libredb.test",
        startLog: () => Promise.reject(new Error("the project has no platform container")),
        now: () => 0,
      },
    });
    expect(formatReport(input({ results }))).toContain("License: unknown, because the check platform-license failed\n");
    expect(formatReport(input())).not.toContain("License:");
  });
});

test("the running services leave out the migrate job of the jobs profile", () => {
  const config = loadConfig({ file: CONFIG, sets: [] });
  expect(runningServices(renderCompose(computeDesired(config, manifestFixture()), TRUST_FIXTURE))).toEqual(
    expect.arrayContaining(["edge", "postgres", "keycloak", "platform", "studio"]),
  );
  expect(runningServices(renderCompose(computeDesired(config, manifestFixture()), TRUST_FIXTURE))).not.toContain("platform-migrate");
});
