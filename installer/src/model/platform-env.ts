// Platform's environments in a self-hosted install: the runtime and the migrate job, each built only from its
// generated descriptors. The runtime never receives MIGRATE_DATABASE_URL, so it never holds the owner role's
// credentials.
import {
  PLATFORM_ENV,
  PLATFORM_MIGRATE_ENV,
  type PlatformEnvKey,
  type PlatformMigrateEnvKey,
} from "../contracts/platform";
import type { LibreDBInstallation } from "../config/schema";
import { ConfigError, LICENSE_TOKEN } from "../config/schema";
import { readSecretReference } from "../config/secret-ref";
import type { Redactor } from "../log/redact";
import { migrateDatabaseUrl, platformDatabaseUrl, type PostgresServer } from "./database-urls";
import type { DesiredInstallation } from "./desired";
import { envConditions, EnvRenderError, proxyInputs, renderEnv } from "./env-render";
import { keycloakAdminHosts, renderNoProxy } from "./no-proxy";

export interface PlatformEnvInputs {
  postgres: PostgresServer;
  secrets: {
    authSecret: string;
    /** AUTH_SECRET_PREVIOUS while a rotation window is open: the value of platform.authSecretPreviousFile. */
    authSecretPrevious?: string;
    /** PLATFORM_LICENSE: the license token of platform.licenseFile; absent on the free tier. */
    license?: string;
    /** The client secret of the Keycloak client `libredb-platform`. */
    oidcClientSecret: string;
    /** The password of libredb_platform. */
    databasePassword: string;
  };
  /** BRIDGE_SEAL_PUBLIC_KEY: the base64url raw X25519 public key of the live seal key. */
  sealPublicKey: string;
  /** The size of the managed PostgreSQL volume in bytes; absent for an external PostgreSQL. */
  platformDbVolumeBytes?: number;
}

export interface PlatformMigrateEnvInputs {
  postgres: PostgresServer;
  secrets: {
    /** The password of libredb_platform, for the seed's DATABASE_URL. */
    databasePassword: string;
    /** The password of libredb_owner, for MIGRATE_DATABASE_URL. */
    ownerPassword: string;
  };
}

export type PlatformEnv = Partial<Record<PlatformEnvKey, string>>;
export type PlatformMigrateEnv = Partial<Record<PlatformMigrateEnvKey, string>>;

/**
 * The previous AUTH_SECRET of a Platform rotation, from the file platform.authSecretPreviousFile names, or
 * undefined while it is unset. A named file that is missing or empty is a configuration error, never a rotation window
 * that ends silently.
 */
export function readAuthSecretPrevious(
  platform: LibreDBInstallation["platform"],
  readFile: (path: string) => string | undefined,
): string | undefined {
  if (platform.authSecretPreviousFile === undefined) return undefined;
  const lookup = readSecretReference(
    { path: "platform.authSecretPrevious", file: platform.authSecretPreviousFile },
    { env: {}, readFile },
  );
  if ("missing" in lookup) throw new ConfigError([`platform.authSecretPreviousFile: ${lookup.missing}`]);
  return lookup.value;
}

/**
 * The license token of PLATFORM_LICENSE, from the file platform.licenseFile names, or undefined while it is unset, and
 * Platform then runs on its free tier. The file holds the token alone on one line and loses one trailing line break. A
 * missing or empty file, or one that holds anything else, is a configuration error that names the file and never its
 * content. The token is registered with the redactor before it is returned, so no output of the run carries it.
 */
export function readPlatformLicense(
  platform: LibreDBInstallation["platform"],
  readFile: (path: string) => string | undefined,
  redactor: Redactor,
): string | undefined {
  if (platform.licenseFile === undefined) return undefined;
  const lookup = readSecretReference({ path: "platform.license", file: platform.licenseFile }, { env: {}, readFile });
  if ("missing" in lookup) throw new ConfigError([`platform.licenseFile: ${lookup.missing}`]);
  if (!LICENSE_TOKEN.test(lookup.value)) {
    throw new ConfigError([
      `platform.licenseFile: the file ${platform.licenseFile} that platform.licenseFile names must hold the license ` +
        "token alone on one line, of the form ldl1.<kid>.<payload>.<signature>",
    ]);
  }
  redactor.register(lookup.value);
  return lookup.value;
}

export function renderPlatformEnv(desired: DesiredInstallation, inputs: PlatformEnvInputs): PlatformEnv {
  const adminUrl = desired.keycloak.platformAdminUrl;
  const previous = inputs.secrets.authSecretPrevious;
  const license = inputs.secrets.license;
  // Platform refuses to start with two equal values, so the installer never writes them.
  if (previous !== undefined && previous === inputs.secrets.authSecret) {
    throw new EnvRenderError(
      "AUTH_SECRET_PREVIOUS equals AUTH_SECRET: regenerate AUTH_SECRET before platform.authSecretPreviousFile names its old value",
    );
  }
  return renderEnv(
    PLATFORM_ENV,
    {
      platformDatabaseUrl: platformDatabaseUrl(inputs.postgres, inputs.secrets.databasePassword),
      authSecret: inputs.secrets.authSecret,
      ...(previous === undefined ? {} : { authSecretPrevious: previous }),
      ...(license === undefined ? {} : { license }),
      platformUrl: desired.urls.platform,
      oidcClientSecret: inputs.secrets.oidcClientSecret,
      issuer: desired.issuer,
      queryLogRetentionDays: String(desired.queryLogRetentionDays),
      studioUrl: desired.urls.studio,
      sealPublicKey: inputs.sealPublicKey,
      noProxy: renderNoProxy(desired.hosts, inputs.postgres.host, keycloakAdminHosts(desired)),
      // The Admin API apart from the public issuer: a managed Keycloak's in-network service, or the URL an external
      // Keycloak's site serves it on; without one Platform derives it from the issuer.
      ...(adminUrl === undefined ? {} : { keycloakAdminUrl: adminUrl }),
      ...(inputs.platformDbVolumeBytes === undefined
        ? {}
        : { platformDbVolumeBytes: String(inputs.platformDbVolumeBytes) }),
      ...proxyInputs(desired),
    },
    envConditions(desired, {
      volumeSize: inputs.platformDbVolumeBytes !== undefined,
      authSecretPrevious: previous !== undefined,
      license: license !== undefined,
    }),
  );
}

/** Exactly the migrate set of the env inventory. */
export function renderPlatformMigrateEnv(
  desired: DesiredInstallation,
  inputs: PlatformMigrateEnvInputs,
): PlatformMigrateEnv {
  return renderEnv(
    PLATFORM_MIGRATE_ENV,
    {
      migrateDatabaseUrl: migrateDatabaseUrl(inputs.postgres, inputs.secrets.ownerPassword),
      platformDatabaseUrl: platformDatabaseUrl(inputs.postgres, inputs.secrets.databasePassword),
      organizationName: desired.organizationName,
    },
    envConditions(desired, { volumeSize: false, authSecretPrevious: false, license: false }),
  );
}
