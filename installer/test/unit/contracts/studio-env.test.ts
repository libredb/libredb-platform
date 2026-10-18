import { describe, expect, test } from "bun:test";
import { STUDIO_ENV, STUDIO_FORBIDDEN, type StudioEnvKey } from "../../../src/contracts/studio";
import { EnvRenderError, renderEnv } from "../../../src/model/env-render";
import { renderStudioEnv, type StudioEnvInputs } from "../../../src/model/studio-env";
import { desiredFixture, POSTGRES } from "./fixture";

const inputs: StudioEnvInputs = {
  postgres: POSTGRES,
  secrets: {
    oidcClientSecret: "studio-client-secret",
    jwtSecret: "jwt-secret",
    storageEncryptionKey: "storage-key",
    databasePassword: "studio-db-password",
  },
};

const GOVERNANCE_REQUIRED = new Set(["always", "oidc", "governance", "internal-ca"]);

describe("renderStudioEnv", () => {
  test("the governance Studio env sets every variable required in governance mode, GOVERNANCE_INSTANCE_ID=libredb-studio included, and none of the variables that must be unset", () => {
    const env = renderStudioEnv(desiredFixture(), inputs);
    const required = (Object.keys(STUDIO_ENV) as StudioEnvKey[]).filter((key) =>
      GOVERNANCE_REQUIRED.has(STUDIO_ENV[key].required),
    );
    expect(required.length).toBeGreaterThan(0);
    for (const key of required) expect(env[key]).toBeString();
    expect(env.GOVERNANCE_INSTANCE_ID).toBe("libredb-studio");
    for (const key of STUDIO_FORBIDDEN) expect(Object.keys(env)).not.toContain(key);
  });

  test("writes the governance values of contracts/env-inventory.yaml", () => {
    const env = renderStudioEnv(desiredFixture(), inputs);
    const url =
      "postgresql://libredb_studio:studio-db-password@postgres:5432/libredb?sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt";
    expect(env).toEqual({
      NEXT_PUBLIC_AUTH_PROVIDER: "oidc",
      OIDC_ISSUER: "https://auth.example.com/realms/libredb",
      OIDC_CLIENT_ID: "libredb-studio",
      OIDC_CLIENT_SECRET: "studio-client-secret",
      OIDC_ROLE_CLAIM: "libredb_roles",
      OIDC_ADMIN_ROLES: "admin",
      OIDC_USER_ROLES: "user",
      OIDC_PROMPT: "omit",
      OIDC_AUTO_REDIRECT: "true",
      AUTH_SESSION_TTL_SECONDS: "28800",
      JWT_SECRET: "jwt-secret",
      AUTH_BOOTSTRAP: "off",
      STORAGE_PROVIDER: "postgres",
      STORAGE_POSTGRES_URL: url,
      STORAGE_POSTGRES_SCHEMA: "studio",
      STORAGE_ENCRYPTION_KEY: "storage-key",
      GOVERNANCE_SOURCE: "postgres",
      GOVERNANCE_POSTGRES_URL: url,
      GOVERNANCE_POSTGRES_SCHEMA: "bridge",
      GOVERNANCE_PRIVATE_KEYS_FILE: "/etc/libredb/governance/keyring.json",
      GOVERNANCE_INSTANCE_ID: "libredb-studio",
      NODE_EXTRA_CA_CERTS: "/etc/libredb/ca/ca.crt",
      NO_PROXY:
        "platform.example.com,studio.example.com,auth.example.com,postgres,.svc,.cluster.local,localhost,127.0.0.1",
      no_proxy:
        "platform.example.com,studio.example.com,auth.example.com,postgres,.svc,.cluster.local,localhost,127.0.0.1",
      PORT: "3000",
      NODE_OPTIONS: "--max-old-space-size=384",
    });
  });

  test("writes OIDC_LOGOUT_HINT only when the release manifest verified it", () => {
    expect(renderStudioEnv(desiredFixture(), inputs).OIDC_LOGOUT_HINT).toBeUndefined();
    expect(renderStudioEnv(desiredFixture({}, true), inputs).OIDC_LOGOUT_HINT).toBe("true");
  });

  test("writes HTTPS_PROXY and NODE_USE_ENV_PROXY=1 only when network.httpsProxy is set", () => {
    const plain = renderStudioEnv(desiredFixture(), inputs);
    expect(plain.HTTPS_PROXY).toBeUndefined();
    expect(plain.NODE_USE_ENV_PROXY).toBeUndefined();
    const proxied = renderStudioEnv(desiredFixture({ network: { httpsProxy: "http://proxy.corp:3128" } }), inputs);
    expect(proxied.HTTPS_PROXY).toBe("http://proxy.corp:3128");
    expect(proxied.NODE_USE_ENV_PROXY).toBe("1");
  });

  test("never writes a variable whose producer is the app default or the operator", () => {
    const env = renderStudioEnv(desiredFixture(), inputs);
    const unwritten = (Object.keys(STUDIO_ENV) as StudioEnvKey[]).filter((key) => STUDIO_ENV[key].when === null);
    expect(unwritten).toContain("OIDC_SCOPE");
    for (const key of unwritten) expect(env[key]).toBeUndefined();
  });
});

describe("renderEnv", () => {
  const descriptor = (value: string) =>
    ({ required: "always", secret: false, producer: "installer", value, when: "always" }) as const;
  const conditions = {
    always: true,
    httpsProxy: false,
    keycloakAdminUrl: false,
    logoutHintVerified: false,
    volumeSize: false,
    authSecretPrevious: false,
  };

  test("refuses a template that names an input the renderer does not have, naming the variable", () => {
    expect(() => renderEnv({ A: descriptor("{{missing}}") }, {}, conditions)).toThrow(
      new EnvRenderError("A: the value template names {{missing}}, which this environment has no input for"),
    );
  });

  test("refuses a value with a line break, which no env file can carry", () => {
    expect(() => renderEnv({ A: descriptor("{{name}}") }, { name: "Acme\nCorp" }, conditions)).toThrow(
      "A: the value contains a line break or a NUL character",
    );
  });
});
