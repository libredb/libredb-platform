// The convergence matrix of R7 in Docker mode: for each combination of a managed or external PostgreSQL
// and a managed or external Keycloak, a clean apply, verify, a second apply that must print No changes, and verify
// again. One external PostgreSQL is provisioned by a DBA with the script of db-script (provisioning manual) and the
// other by the installer as the admin role. On the install with an external PostgreSQL and an external Keycloak, an
// `apply --renew-certificates` run without either admin credential, as the renewal timer runs it, skips the steps that
// need them with a note and still passes verify.
// Each combination starts from no install at all and leaves none. LIBREDB_E2E_MATRIX names the combinations to run, by
// their fixture names under test/fixtures/configs/matrix/ separated by commas, so the nightly workflow runs one per job;
// all four run by default. The externals come from ./support/externals.ts, and ./support/install.ts names the
// installer binary and the image registry.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGUE } from "../../src/verify/catalogue";
import {
  connectExternalKeycloak,
  CORP_FILES,
  EXTERNAL_KEYCLOAK,
  EXTERNAL_POSTGRES,
  KEYCLOAK_BASE_URL,
  KEYCLOAK_SECRET_ENV,
  POSTGRES_ADMIN_ENV,
  POSTGRES_ADMIN_USER,
  POSTGRES_HOST,
  removeExternals,
  startExternalKeycloak,
  startExternalPostgres,
} from "./support/externals";
import {
  failedChecks,
  installer,
  LICENSE_ARGS,
  PACKAGE_ROOT,
  REGISTRY_ARGS,
  removeInstall,
  requireDisposableHost,
  VERIFIED,
  type VerifyReport,
} from "./support/install";

interface Combination {
  /** The fixture's name under test/fixtures/configs/matrix/, without .yaml. */
  name: string;
  postgres: "managed" | "external-manual" | "external-installer";
  keycloak: "managed" | "external";
}

const COMBINATIONS: readonly Combination[] = [
  { name: "managed-pg-managed-kc", postgres: "managed", keycloak: "managed" },
  { name: "external-pg-managed-kc", postgres: "external-manual", keycloak: "managed" },
  { name: "managed-pg-external-kc", postgres: "managed", keycloak: "external" },
  { name: "external-pg-external-kc", postgres: "external-installer", keycloak: "external" },
];
const PER_COMBINATION = 30 * 60_000;

function selected(): Combination[] {
  const names = (process.env.LIBREDB_E2E_MATRIX ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return [...COMBINATIONS];
  const unknown = names.filter((name) => !COMBINATIONS.some((combination) => combination.name === name));
  if (unknown.length > 0) {
    throw new Error(`LIBREDB_E2E_MATRIX names no combination ${unknown.join(", ")}; known: ${COMBINATIONS.map((c) => c.name).join(", ")}`);
  }
  return COMBINATIONS.filter((combination) => names.includes(combination.name));
}

const combinations = selected();

function removeAll(): void {
  removeInstall([EXTERNAL_POSTGRES, EXTERNAL_KEYCLOAK]);
  removeExternals();
}

/** Asserts that verify passes every check of the catalogue. */
async function verifies(args: string[], env: Record<string, string | undefined>): Promise<void> {
  const verify = await installer(["verify", ...args, "--output", "json"], env);
  const report = JSON.parse(verify.stdout) as VerifyReport;
  expect(report.checks.map((check) => check.id)).toEqual(CATALOGUE.map((check) => check.id));
  expect(failedChecks(report)).toEqual([]);
  expect({ code: verify.code, stderr: verify.stderr }).toEqual({ code: 0, stderr: "" });
}

/** Installs `combination` from nothing, converges it twice and verifies each time, then removes it. */
async function converge(combination: Combination): Promise<void> {
  removeAll();
  const args = [
    "-c",
    join(PACKAGE_ROOT, "test", "fixtures", "configs", "matrix", `${combination.name}.yaml`),
    ...REGISTRY_ARGS,
    ...LICENSE_ARGS,
  ];
  const externalKeycloak = combination.keycloak === "external";
  if (externalKeycloak) args.push("--set", `keycloak.external.baseUrl=${KEYCLOAK_BASE_URL}`);
  // The credentials of every run that needs them; a key with an undefined value keeps the variable unset.
  const credentials: Record<string, string | undefined> = { [POSTGRES_ADMIN_ENV]: undefined, [KEYCLOAK_SECRET_ENV]: undefined };

  if (combination.postgres !== "managed") {
    const server = await startExternalPostgres(combination.postgres === "external-installer");
    if (combination.postgres === "external-installer") credentials[POSTGRES_ADMIN_ENV] = server.adminPassword;
    else {
      // The DBA runs the installer's script on the server before the first apply, as a superuser.
      const script = join(CORP_FILES, "dba.sql");
      const written = await installer(["db-script", ...args, "-o", script]);
      expect({ code: written.code, stderr: written.stderr }).toEqual({ code: 0, stderr: "" });
      // An existing script is replaced only with --force.
      const again = await installer(["db-script", ...args, "-o", script]);
      expect({ code: again.code, stderr: again.stderr }).toEqual({
        code: 2,
        stderr: `db-script: ${script} already exists; pass --force to replace it\n`,
      });
      const replaced = await installer(["db-script", ...args, "-o", script, "--force"]);
      expect({ code: replaced.code, stderr: replaced.stderr }).toEqual({ code: 0, stderr: "" });
      server.psql(undefined, "postgres", readFileSync(script));
    }
  }
  if (externalKeycloak) {
    credentials[KEYCLOAK_SECRET_ENV] = (await startExternalKeycloak()).provisionerSecret;
    // The installation's networks come first, so the corp Keycloak joins libredb_edge under its public name.
    const base = await installer(["apply", ...args, "--only", "preflight,images,secrets,tls,base", "--yes"], credentials);
    expect({ code: base.code, stderr: base.stderr }).toEqual({ code: 0, stderr: "" });
    connectExternalKeycloak();
  }

  const first = await installer(["apply", ...args, "--yes"], credentials);
  expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: "" });
  expect(first.stdout).toContain(VERIFIED);
  await verifies(args, credentials);

  const second = await installer(["apply", ...args, "--yes"], credentials);
  expect({ code: second.code, stderr: second.stderr }).toEqual({ code: 0, stderr: "" });
  expect(second.stdout).toContain("No changes\n");
  expect(second.stdout).toContain(VERIFIED);
  await verifies(args, credentials);

  if (combination.postgres === "external-installer" && externalKeycloak) {
    // The renewal timer's run: no admin credential of either server, and leaves that change nothing else.
    const renewal = await installer(["apply", ...args, "--renew-certificates", "--yes"], {
      [POSTGRES_ADMIN_ENV]: undefined,
      [KEYCLOAK_SECRET_ENV]: undefined,
    });
    expect({ code: renewal.code, stderr: renewal.stderr }).toEqual({ code: 0, stderr: "" });
    expect(renewal.stdout).toContain("apply --renew-certificates re-issues every leaf");
    expect(renewal.stdout).toContain(
      "postgres-provision was skipped, because its inputs are unchanged since it last succeeded and no password of " +
        `the admin role ${POSTGRES_ADMIN_USER} of the external PostgreSQL server ${POSTGRES_HOST}:5432 is supplied`,
    );
    expect(renewal.stdout).toContain(`keycloak.external.adminClientSecretEnv names ${KEYCLOAK_SECRET_ENV}, which is not set`);
    expect(renewal.stdout).toContain(VERIFIED);
    await verifies(args, {});
  }
  removeAll();
}

beforeAll(() => {
  requireDisposableHost();
});

afterAll(() => {
  removeAll();
});

describe("the convergence matrix in Docker mode", () => {
  test(
    "converges twice in each of the four combinations of PostgreSQL mode and Keycloak mode",
    async () => {
      // Every selected combination runs even when an earlier one fails, and the result names each failure.
      const failures: { combination: string; error: string }[] = [];
      for (const combination of combinations) {
        const startedAt = Date.now();
        try {
          await converge(combination);
          console.log(`${combination.name}: converged in ${Math.round((Date.now() - startedAt) / 1000)} s`);
        } catch (error) {
          failures.push({ combination: combination.name, error: error instanceof Error ? error.message : String(error) });
          console.log(`${combination.name}: failed after ${Math.round((Date.now() - startedAt) / 1000)} s`);
        }
      }
      expect(failures).toEqual([]);
    },
    combinations.length * PER_COMBINATION,
  );
});
