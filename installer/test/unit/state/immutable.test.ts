import { describe, expect, test } from "bun:test";
import { parseInstallation } from "../../../src/config/schema";
import { checkImmutable, immutableFieldsOf, UnsafeChangeError } from "../../../src/state/immutable";

function fieldsOf(overrides: Record<string, unknown> = {}) {
  return immutableFieldsOf(
    parseInstallation({
      apiVersion: "install.libredb.org/v1",
      kind: "LibreDBInstallation",
      metadata: { name: "acme" },
      mode: "docker",
      endpoints: { hosts: { platform: "platform.corp", studio: "studio.corp", auth: "auth.corp" } },
      platform: { organizationName: "Acme", licenseFile: "/etc/libredb/platform.license" },
      ...overrides,
    }),
  );
}

function refusal(run: () => void): UnsafeChangeError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnsafeChangeError) return error;
    throw error;
  }
  throw new Error("expected an UnsafeChangeError");
}

describe("immutable fields", () => {
  test("changing postgres.mode from managed to external exits 6", () => {
    const error = refusal(() => checkImmutable(fieldsOf(), fieldsOf({ postgres: { mode: "external", external: { host: "db.corp", adminUser: "dba" } } })));
    expect(error.exitCode).toBe(6);
    expect(error.changes).toEqual([{ field: "postgres.mode", recorded: "managed", desired: "external" }]);
    expect(error.message).toBe(
      "refusing an unsafe change: these fields cannot change once the installation exists\n" +
        "  postgres.mode: managed when the installation was created, external now",
    );
  });

  test("names every changed field: the mode, the Keycloak mode and the realm", () => {
    const desired = fieldsOf({
      mode: "kubernetes",
      keycloak: {
        mode: "external",
        realm: "corp",
        external: { baseUrl: "https://auth.corp", adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD" },
      },
    });
    expect(refusal(() => checkImmutable(fieldsOf(), desired)).changes).toEqual([
      { field: "mode", recorded: "docker", desired: "kubernetes" },
      { field: "keycloak.mode", recorded: "managed", desired: "external" },
      { field: "keycloak.realm", recorded: "libredb", desired: "corp" },
    ]);
  });

  test("a database or role name that differs from the one the installation was created with is refused", () => {
    const recorded = {
      ...fieldsOf(),
      "postgres.database": "libredb_prod",
      "postgres.roles.studio": "studio_runtime",
    };
    expect(refusal(() => checkImmutable(recorded, fieldsOf())).changes).toEqual([
      { field: "postgres.database", recorded: "libredb_prod", desired: "libredb" },
      { field: "postgres.roles.studio", recorded: "studio_runtime", desired: "libredb_studio" },
    ]);
  });

  test("the other fields of the configuration may change", () => {
    const changed = fieldsOf({
      endpoints: { hosts: { platform: "p.corp", studio: "s.corp", auth: "a.corp" } },
      tls: { mode: "external", caBundleFile: "/etc/pki/corp-ca.pem", external: { trustedProxies: ["192.0.2.10/32"] } },
      keycloak: { adminPort: 28080, firstAdmin: { username: "dba" } },
      platform: { organizationName: "Acme Corp", licenseFile: "/etc/libredb/platform.license" },
      docker: { systemdUnit: true },
    });
    expect(() => checkImmutable(fieldsOf(), changed)).not.toThrow();
  });

  test("records the modes and the realm of the configuration and the PostgreSQL database and role names", () => {
    expect(fieldsOf({ keycloak: { realm: "corp" } })).toEqual({
      mode: "docker",
      "postgres.mode": "managed",
      "keycloak.mode": "managed",
      "keycloak.realm": "corp",
      "postgres.database": "libredb",
      "postgres.keycloakDatabase": "keycloak",
      "postgres.roles.owner": "libredb_owner",
      "postgres.roles.platform": "libredb_platform",
      "postgres.roles.studio": "libredb_studio",
      "postgres.roles.keycloak": "libredb_keycloak",
    });
  });
});
