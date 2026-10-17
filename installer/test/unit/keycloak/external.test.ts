import { describe, expect, test } from "bun:test";
import type { ExternalKeycloak } from "../../../src/config/schema";
import {
  ADMIN_CLI,
  adminAccess,
  lookupAdminCredentials,
  MissingCredentialError,
  type CredentialSources,
} from "../../../src/keycloak/external";

const BASE = { baseUrl: "https://sso.corp.test", provisioning: "installer", adminRealm: "master" } as const;

function sources(env: Record<string, string> = {}, files: Record<string, string> = {}): CredentialSources {
  return { env, readFile: (path) => files[path] };
}

describe("lookupAdminCredentials", () => {
  test("reads a client's secret from its environment variable, for a token of the admin realm", () => {
    const external: ExternalKeycloak = { ...BASE, adminRealm: "corp", adminClientId: "provisioner", adminClientSecretEnv: "KC_SECRET" };
    expect(lookupAdminCredentials(external, sources({ KC_SECRET: "s3cret" }))).toEqual({
      credentials: { realm: "corp", clientId: "provisioner", clientSecret: "s3cret" },
      secret: "s3cret",
    });
  });

  test("reads a user's password from its file without the last line break, and signs in through admin-cli", () => {
    const external: ExternalKeycloak = { ...BASE, adminUser: "admin", adminPasswordFile: "/root/kc-admin" };
    expect(lookupAdminCredentials(external, sources({}, { "/root/kc-admin": "pass word\n" }))).toEqual({
      credentials: { realm: "master", clientId: ADMIN_CLI, username: "admin", password: "pass word" },
      secret: "pass word",
    });
    expect(ADMIN_CLI).toBe("admin-cli");
  });

  test("names a reference that this run does not supply", () => {
    const env: ExternalKeycloak = { ...BASE, adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD" };
    expect(lookupAdminCredentials(env, sources())).toEqual({
      missing: "keycloak.external.adminPasswordEnv names KC_ADMIN_PASSWORD, which is not set",
    });
    expect(lookupAdminCredentials(env, sources({ KC_ADMIN_PASSWORD: "" }))).toEqual({
      missing: "keycloak.external.adminPasswordEnv names KC_ADMIN_PASSWORD, which is not set",
    });
    const file: ExternalKeycloak = { ...BASE, adminClientId: "provisioner", adminClientSecretFile: "/root/kc-secret" };
    expect(lookupAdminCredentials(file, sources())).toEqual({
      missing: "keycloak.external.adminClientSecretFile names /root/kc-secret, which does not exist",
    });
  });

  test("refuses an empty secret file and a configuration that validation would have refused", () => {
    const file: ExternalKeycloak = { ...BASE, adminClientId: "provisioner", adminClientSecretFile: "/root/kc-secret" };
    expect(() => lookupAdminCredentials(file, sources({}, { "/root/kc-secret": "\n" }))).toThrow(
      "/root/kc-secret, which keycloak.external.adminClientSecretFile names, is empty",
    );
    expect(() => lookupAdminCredentials({ ...BASE, adminClientId: "provisioner" }, sources())).toThrow(
      "keycloak.external sets neither adminClientSecretEnv nor adminClientSecretFile",
    );
    expect(() => lookupAdminCredentials({ ...BASE }, sources())).toThrow(
      "keycloak.external sets neither adminClientId nor adminUser",
    );
    expect(() => lookupAdminCredentials({ baseUrl: BASE.baseUrl, provisioning: "manual" }, sources())).toThrow(
      "keycloak.external.provisioning is manual, so the installer uses no Keycloak admin credential",
    );
  });
});

describe("adminAccess", () => {
  const found = lookupAdminCredentials(
    { ...BASE, adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD" },
    sources({ KC_ADMIN_PASSWORD: "pw" }),
  );
  const missing = { missing: "keycloak.external.adminPasswordEnv names KC_ADMIN_PASSWORD, which is not set" };

  test("a run with the credential uses it, whatever the inputs", () => {
    for (const unchanged of [true, false]) {
      expect(adminAccess(found, unchanged, "keycloak-configure")).toEqual({
        credentials: { realm: "master", clientId: "admin-cli", username: "admin", password: "pw" },
      });
    }
  });

  test("a run without it skips with a note while the Keycloak inputs are unchanged, as an unattended renewal apply does", () => {
    expect(adminAccess(missing, true, "keycloak-configure")).toEqual({
      skipped:
        "keycloak-configure: skipped, because keycloak.external.adminPasswordEnv names KC_ADMIN_PASSWORD, which is not " +
        "set, and the Keycloak inputs are unchanged since keycloak-configure last converged the realm",
    });
  });

  test("a run without it is refused with exit 2 when the realm has to change", () => {
    let caught: unknown;
    try {
      adminAccess(missing, false, "keycloak-configure");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingCredentialError);
    expect((caught as MissingCredentialError).exitCode).toBe(2);
    expect((caught as MissingCredentialError).message).toBe(
      "keycloak.external.adminPasswordEnv names KC_ADMIN_PASSWORD, which is not set; keycloak-configure needs the admin " +
        "credential of the customer's Keycloak, which the installer reads on each run that changes the realm and never stores",
    );
  });
});
