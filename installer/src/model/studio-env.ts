// Studio's environment in a governance install, built only from the generated descriptors.
import { STUDIO_ENV, type StudioEnvKey } from "../contracts/studio";
import { studioDatabaseUrl, type PostgresServer } from "./database-urls";
import type { DesiredInstallation } from "./desired";
import { envConditions, proxyInputs, renderEnv } from "./env-render";
import { keycloakAdminHosts, renderNoProxy } from "./no-proxy";

/** What Studio's environment needs beyond the desired model: the PostgreSQL server and the secret store's values. */
export interface StudioEnvInputs {
  postgres: PostgresServer;
  secrets: {
    /** The client secret of the Keycloak client `libredb-studio`. */
    oidcClientSecret: string;
    jwtSecret: string;
    storageEncryptionKey: string;
    /** The password of libredb_studio. */
    databasePassword: string;
  };
}

export type StudioEnv = Partial<Record<StudioEnvKey, string>>;

export function renderStudioEnv(desired: DesiredInstallation, inputs: StudioEnvInputs): StudioEnv {
  return renderEnv(
    STUDIO_ENV,
    {
      issuer: desired.issuer,
      oidcClientSecret: inputs.secrets.oidcClientSecret,
      jwtSecret: inputs.secrets.jwtSecret,
      storageEncryptionKey: inputs.secrets.storageEncryptionKey,
      studioDatabaseUrl: studioDatabaseUrl(inputs.postgres, inputs.secrets.databasePassword),
      noProxy: renderNoProxy(desired.hosts, inputs.postgres.host, keycloakAdminHosts(desired)),
      ...proxyInputs(desired),
    },
    envConditions(desired, { volumeSize: false, authSecretPrevious: false, license: false }),
  );
}
