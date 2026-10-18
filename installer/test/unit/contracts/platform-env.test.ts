import { describe, expect, test } from "bun:test";
import { exitCodeOf } from "../../../src/cli/commands/docker-session";
import { ExitCode } from "../../../src/cli/exit-codes";
import { PLATFORM_ENV, PLATFORM_MIGRATE_ENV, type PlatformEnvKey } from "../../../src/contracts/platform";
import { ConfigError } from "../../../src/config/schema";
import { formatLogLine, REDACTED, Redactor } from "../../../src/log/redact";
import {
  readAuthSecretPrevious,
  readPlatformLicense,
  renderPlatformEnv,
  renderPlatformMigrateEnv,
  type PlatformEnvInputs,
  type PlatformMigrateEnvInputs,
} from "../../../src/model/platform-env";
import { desiredFixture, POSTGRES } from "./fixture";

// A value of the license token's shape that no key signed: the installer checks only the shape.
const token = ["ldl1", "0123456789abcdef", Buffer.from('{"v":1}').toString("base64url"), Buffer.alloc(64).toString("base64url")].join(".");

const inputs: PlatformEnvInputs = {
  postgres: POSTGRES,
  secrets: {
    authSecret: "auth-secret",
    license: token,
    oidcClientSecret: "platform-client-secret",
    databasePassword: "platform-pw",
  },
  sealPublicKey: "c2VhbC1wdWJsaWMta2V5",
};

// The platform section of desiredFixture, with the platform.licenseFile that every configuration names.
const PLATFORM = { organizationName: "Acme Corp", licenseFile: "/etc/libredb/platform.license" };

const migrateInputs: PlatformMigrateEnvInputs = {
  postgres: POSTGRES,
  secrets: { databasePassword: "platform-pw", ownerPassword: "owner-pw" },
};

const DATABASE_URL =
  "postgresql://libredb_platform:platform-pw@postgres:5432/libredb?schema=platform&sslmode=verify-full&sslrootcert=/etc/libredb/ca/ca.crt";

/** A reused realm corp of the customer's Keycloak at the example auth host, plus keycloak.external fields. */
const external = (fields: Record<string, unknown> = {}) => ({
  keycloak: {
    mode: "external",
    realm: "corp",
    external: { baseUrl: "https://auth.example.com/auth", adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD", ...fields },
  },
});

describe("renderPlatformEnv", () => {
  test("the Platform runtime env never contains MIGRATE_DATABASE_URL or PLATFORM_ORGANIZATION_NAME", () => {
    for (const desired of [desiredFixture(), desiredFixture(external())]) {
      const keys = Object.keys(renderPlatformEnv(desired, inputs));
      expect(keys).not.toContain("MIGRATE_DATABASE_URL");
      expect(keys).not.toContain("PLATFORM_ORGANIZATION_NAME");
    }
    expect(Object.keys(PLATFORM_ENV)).not.toContain("MIGRATE_DATABASE_URL");
    expect(Object.keys(PLATFORM_ENV)).not.toContain("PLATFORM_ORGANIZATION_NAME");
  });

  test("writes the self-hosted values of contracts/env-inventory.yaml", () => {
    expect(renderPlatformEnv(desiredFixture(), inputs)).toEqual({
      NODE_EXTRA_CA_CERTS: "/etc/libredb/ca/ca.crt",
      DEPLOYMENT_MODE: "self-hosted",
      DATABASE_URL,
      AUTH_SECRET: "auth-secret",
      AUTH_URL: "https://platform.example.com",
      AUTH_KEYCLOAK_ID: "libredb-platform",
      AUTH_KEYCLOAK_SECRET: "platform-client-secret",
      AUTH_KEYCLOAK_ISSUER: "https://auth.example.com/realms/libredb",
      KEYCLOAK_ADMIN_URL: "http://keycloak:8080",
      QUERY_LOG_RETENTION_DAYS: "90",
      STUDIO_PUBLIC_URL: "https://studio.example.com",
      BRIDGE_SEAL_PUBLIC_KEY: "c2VhbC1wdWJsaWMta2V5",
      STORAGE_PROVIDER: "LOCAL",
      STORAGE_LOCAL_PATH: "/app/uploads",
      NO_PROXY:
        "platform.example.com,studio.example.com,auth.example.com,postgres,.svc,.cluster.local,localhost,127.0.0.1",
      no_proxy:
        "platform.example.com,studio.example.com,auth.example.com,postgres,.svc,.cluster.local,localhost,127.0.0.1",
      PORT: "3000",
      PLATFORM_LICENSE: token,
    });
  });

  test("platform.queryLogRetentionDays outside Platform's bounds of 1 to 36500 fails validation", () => {
    for (const days of [0, 36501, 1.5]) {
      expect(() => desiredFixture({ platform: { ...PLATFORM, queryLogRetentionDays: days } })).toThrow(
        "platform.queryLogRetentionDays",
      );
    }
  });

  test("writes KEYCLOAK_ADMIN_URL for an external Keycloak only when keycloak.external.adminUrl is set, so Platform otherwise derives it from the issuer", () => {
    const derived = renderPlatformEnv(desiredFixture(external()), inputs);
    expect({ issuer: derived.AUTH_KEYCLOAK_ISSUER, admin: derived.KEYCLOAK_ADMIN_URL }).toEqual({
      issuer: "https://auth.example.com/auth/realms/corp",
      admin: undefined,
    });
    expect(derived.NO_PROXY).toBe(
      "platform.example.com,studio.example.com,auth.example.com,postgres,.svc,.cluster.local,localhost,127.0.0.1",
    );

    // An Admin API the site serves on its own host is where Platform calls it, so NO_PROXY keeps that host direct.
    const separate = renderPlatformEnv(desiredFixture(external({ adminUrl: "https://sso-admin.corp.internal:9443/" })), inputs);
    expect(separate.KEYCLOAK_ADMIN_URL).toBe("https://sso-admin.corp.internal:9443");
    expect(separate.NO_PROXY).toBe(
      "platform.example.com,studio.example.com,auth.example.com,sso-admin.corp.internal,postgres,.svc,.cluster.local,localhost,127.0.0.1",
    );
  });

  test("passes QUERY_LOG_RETENTION_DAYS, the proxy and the volume size through", () => {
    const env = renderPlatformEnv(
      desiredFixture({
        platform: { ...PLATFORM, queryLogRetentionDays: 36500 },
        network: { httpsProxy: "https://proxy.corp:3128" },
      }),
      { ...inputs, platformDbVolumeBytes: 21474836480 },
    );
    expect(env.QUERY_LOG_RETENTION_DAYS).toBe("36500");
    expect(env.HTTPS_PROXY).toBe("https://proxy.corp:3128");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    expect(env.PLATFORM_DB_VOLUME_BYTES).toBe("21474836480");
  });

  test("never writes a variable whose producer is the app default or the operator", () => {
    const env = renderPlatformEnv(desiredFixture(), inputs);
    const unwritten = (Object.keys(PLATFORM_ENV) as PlatformEnvKey[]).filter((key) => PLATFORM_ENV[key].when === null);
    expect(unwritten).toContain("PLATFORM_ROLE_CLAIM");
    for (const key of unwritten) expect(env[key]).toBeUndefined();
  });

  test("AUTH_SECRET_PREVIOUS is written only while platform.authSecretPreviousFile is set", () => {
    const files: Record<string, string> = { "/root/auth-secret-previous": "previous-auth-secret\n" };
    const readFile = (path: string) => files[path];

    const unset = readAuthSecretPrevious(PLATFORM, readFile);
    expect(unset).toBeUndefined();
    const without = renderPlatformEnv(desiredFixture(), inputs);
    expect(Object.keys(without)).not.toContain("AUTH_SECRET_PREVIOUS");

    const previous = readAuthSecretPrevious({ ...PLATFORM, authSecretPreviousFile: "/root/auth-secret-previous" }, readFile);
    expect(previous).toBe("previous-auth-secret");
    const rotating = renderPlatformEnv(desiredFixture(), {
      ...inputs,
      secrets: { ...inputs.secrets, authSecretPrevious: previous },
    });
    expect(rotating.AUTH_SECRET_PREVIOUS).toBe("previous-auth-secret");
    expect(rotating.AUTH_SECRET).toBe("auth-secret");

    // A file the configuration names but the host lacks is an error, never a rotation window that silently ends.
    expect(() => readAuthSecretPrevious({ ...PLATFORM, authSecretPreviousFile: "/root/missing" }, readFile)).toThrow(ConfigError);
    // Platform refuses to start when both values are equal, so the installer refuses to write them.
    expect(() =>
      renderPlatformEnv(desiredFixture(), { ...inputs, secrets: { ...inputs.secrets, authSecretPrevious: "auth-secret" } }),
    ).toThrow("AUTH_SECRET_PREVIOUS equals AUTH_SECRET");
  });
});

describe("PLATFORM_LICENSE", () => {
  const licensed = { organizationName: "Acme Corp", licenseFile: "/root/libredb.license" };
  const holding = (content: string) => (path: string) => (path === licensed.licenseFile ? content : undefined);

  /** The error readPlatformLicense throws for a license file with this content, or for a missing file when undefined. */
  function refusal(content: string | undefined): unknown {
    try {
      readPlatformLicense(licensed, content === undefined ? () => undefined : holding(content), new Redactor());
    } catch (error) {
      return error;
    }
    throw new Error("expected the license file to be refused");
  }

  test("is always written with the token of platform.licenseFile, which Platform requires in a self-hosted install, and never in the migrate env", () => {
    const license = readPlatformLicense(licensed, holding(`${token}\n`), new Redactor());
    expect(license).toBe(token);
    const desired = desiredFixture({ platform: licensed });
    const env = renderPlatformEnv(desired, { ...inputs, secrets: { ...inputs.secrets, license } });
    expect(env.PLATFORM_LICENSE).toBe(token);
    expect(PLATFORM_ENV.PLATFORM_LICENSE).toEqual({
      required: "self-hosted",
      secret: true,
      producer: "config",
      value: "{{license}}",
      when: "always",
    });

    // The migrate job never receives the license.
    expect(Object.keys(PLATFORM_MIGRATE_ENV)).not.toContain("PLATFORM_LICENSE");
    expect(Object.keys(renderPlatformMigrateEnv(desired, migrateInputs))).not.toContain("PLATFORM_LICENSE");
  });

  test("a Platform env without the license token is refused naming PLATFORM_LICENSE, never rendered without it", () => {
    const unlicensed = { ...inputs.secrets, license: undefined } as unknown as PlatformEnvInputs["secrets"];
    expect(() => renderPlatformEnv(desiredFixture(), { ...inputs, secrets: unlicensed })).toThrow(
      "PLATFORM_LICENSE: the value template names {{license}}, which this environment has no input for",
    );
  });

  test("a missing or empty license file stops apply with exit 2, naming the file", () => {
    const cases = [
      { content: undefined, issue: "platform.licenseFile: the file /root/libredb.license that platform.licenseFile names does not exist" },
      { content: "", issue: "platform.licenseFile: the file /root/libredb.license that platform.licenseFile names is empty" },
      { content: "\n", issue: "platform.licenseFile: the file /root/libredb.license that platform.licenseFile names is empty" },
    ];
    for (const { content, issue } of cases) {
      const error = refusal(content);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toEqual([issue]);
      expect(exitCodeOf(error)).toBe(ExitCode.InvalidUsage);
    }
  });

  test("a file that holds anything but one token-shaped line stops apply with exit 2, naming the file and never its content", () => {
    const issue =
      "platform.licenseFile: the file /root/libredb.license that platform.licenseFile names must hold the license " +
      "token alone on one line, of the form ldl1.<kid>.<payload>.<signature>";
    const [prefix, kid, payload, signature] = token.split(".");
    const contents = [
      `${token}\n${token}\n`,
      `${token}\n\n`,
      ` ${token}`,
      `${token} \n`,
      `"${token}"`,
      `\uFEFF${token}`,
      `PLATFORM_LICENSE=${token}`,
      `ldl2.${kid}.${payload}.${signature}`,
      `${prefix}.${kid?.toUpperCase()}.${payload}.${signature}`,
      `${prefix}.${kid?.slice(1)}.${payload}.${signature}`,
      `${prefix}.${kid}.${payload}`,
      `${prefix}.${kid}.${payload}.${signature}.${signature}`,
      `${prefix}.${kid}.${payload}.`,
      `${prefix}.${kid}.${payload}.${signature}=`,
    ];
    for (const content of contents) {
      const error = refusal(content);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toEqual([issue]);
      expect(exitCodeOf(error)).toBe(ExitCode.InvalidUsage);
    }
  });

  test("the token is registered with the redactor as it is read, so no log line of the run carries it", () => {
    const redactor = new Redactor();
    const license = readPlatformLicense(licensed, holding(`${token}\r\n`), redactor);
    expect(license).toBe(token);
    const line = formatLogLine({ time: new Date(0), level: "debug", message: `stdout: PLATFORM_LICENSE=${token}` }, redactor);
    expect(line).toBe(`{"time":"1970-01-01T00:00:00.000Z","level":"debug","msg":"stdout: PLATFORM_LICENSE=${REDACTED}"}\n`);
  });
});

describe("renderPlatformMigrateEnv", () => {
  test("the migrate env holds exactly MIGRATE_DATABASE_URL, DATABASE_URL, DEPLOYMENT_MODE, PLATFORM_ORGANIZATION_NAME and NODE_EXTRA_CA_CERTS", () => {
    const env = renderPlatformMigrateEnv(
      desiredFixture({ network: { httpsProxy: "http://proxy.corp:3128" } }),
      migrateInputs,
    );
    expect(Object.keys(env).sort()).toEqual(
      ["DATABASE_URL", "DEPLOYMENT_MODE", "MIGRATE_DATABASE_URL", "NODE_EXTRA_CA_CERTS", "PLATFORM_ORGANIZATION_NAME"],
    );
    expect(env).toEqual({
      NODE_EXTRA_CA_CERTS: "/etc/libredb/ca/ca.crt",
      DEPLOYMENT_MODE: "self-hosted",
      DATABASE_URL,
      MIGRATE_DATABASE_URL:
        "postgresql://libredb_owner:owner-pw@postgres:5432/libredb?schema=platform&sslmode=require&sslcert=/etc/libredb/ca/ca.crt&sslaccept=strict",
      PLATFORM_ORGANIZATION_NAME: "Acme Corp",
    });
  });
});
