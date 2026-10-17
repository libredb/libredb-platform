// Plans the secrets step: generate each secret the installation needs that the store does not hold, record the
// fingerprint of each in the state, and issue the first seal key. Only names, kids and fingerprints pass through
// here, never a value.
import type { LibreDBInstallation } from "../config/schema";
import type { SecretReference } from "../config/secret-ref";
import type { Action } from "../engine/step";
import { CLIENT_SECRET_NAMES } from "../keycloak/desired";
import { MissingCredentialError } from "../keycloak/external";
import { activeSealKey } from "../secrets/seal-rotation";
import type { SealKeyState } from "../secrets/store";
import { roleSecretNames } from "../sql/provision";

/** The password of the managed PostgreSQL superuser `postgres`. */
export const POSTGRES_SUPERUSER_SECRET = "postgres-superuser-password";

/** The generated secrets of the apps, each an independent draw. */
export const APP_SECRET_NAMES = {
  /** Platform's AUTH_SECRET, never shared with Studio. */
  platformAuthSecret: "platform-auth-secret",
  /** Studio's JWT_SECRET. */
  studioJwtSecret: "studio-jwt-secret",
  /** Studio's STORAGE_ENCRYPTION_KEY. */
  studioStorageEncryptionKey: "studio-storage-encryption-key",
} as const;

/**
 * The generated secrets of a Docker install: the password of the managed PostgreSQL superuser, which an external server
 * does not have, the password of every role provisioning creates, the Keycloak role only for a managed Keycloak, the
 * secrets of the Keycloak clients libredb-studio and libredb-platform unless the site configures the realm and supplies
 * them, and the secrets of the apps.
 */
export function dockerSecretNames(config: LibreDBInstallation): string[] {
  const siteClients = siteSecretReferences(config).length > 0;
  return [
    ...(config.postgres.mode === "managed" ? [POSTGRES_SUPERUSER_SECRET] : []),
    ...roleSecretNames(config.keycloak.mode === "managed"),
    ...(siteClients ? [] : [CLIENT_SECRET_NAMES.studio, CLIENT_SECRET_NAMES.platform]),
    APP_SECRET_NAMES.platformAuthSecret,
    APP_SECRET_NAMES.studioJwtSecret,
    APP_SECRET_NAMES.studioStorageEncryptionKey,
  ];
}

export interface SecretAction extends Action {
  kind: "generate" | "store" | "record" | "seal-key";
  name: string;
}

/** A secret the site supplies through a reference of the configuration, stored under its store name. */
export interface SiteSecret {
  name: string;
  reference: SecretReference;
}

/**
 * The secrets of libredb-studio and libredb-platform that the site's Keycloak generated, with
 * keycloak.external.provisioning manual; none otherwise, because the installer generates them.
 */
export function siteSecretReferences(config: LibreDBInstallation): SiteSecret[] {
  const { keycloak } = config;
  if (keycloak.mode !== "external" || keycloak.external.provisioning !== "manual") return [];
  const { external } = keycloak;
  return [
    {
      name: CLIENT_SECRET_NAMES.studio,
      reference: { path: "keycloak.external.studioClientSecret", env: external.studioClientSecretEnv, file: external.studioClientSecretFile },
    },
    {
      name: CLIENT_SECRET_NAMES.platform,
      reference: {
        path: "keycloak.external.platformClientSecret",
        env: external.platformClientSecretEnv,
        file: external.platformClientSecretFile,
      },
    },
  ];
}

/** A site secret as this run found it: the fingerprint of the supplied value, or why its reference supplies none. */
export interface SiteSecretLookup {
  name: string;
  /** The configuration path of the secret without its Env or File suffix. */
  path: string;
  supplied: { fingerprint: string } | { missing: string };
}

/**
 * Stores each site secret whose supplied value the store lacks or holds differently, and records its fingerprint. A
 * run whose reference supplies nothing, such as the unattended renewal timer without the variable, keeps the stored
 * value with a warning; without a stored value it is refused with exit 2 naming the reference.
 */
export function planSiteSecrets(
  lookups: readonly SiteSecretLookup[],
  stored: Readonly<Record<string, string>>,
  recorded: Readonly<Record<string, string>>,
): { actions: SecretAction[]; warnings: string[] } {
  const actions: SecretAction[] = [];
  const warnings: string[] = [];
  for (const { name, path, supplied } of lookups) {
    if ("missing" in supplied) {
      if (stored[name] === undefined) {
        throw new MissingCredentialError(
          `${supplied.missing}; provisioning manual needs the secret of ${path}, which the site's Keycloak generated`,
        );
      }
      warnings.push(`${supplied.missing}, so the installer keeps the secret of ${path} it stored before`);
    } else if (stored[name] !== supplied.fingerprint) {
      actions.push({ kind: "store", name, summary: `store the secret of ${name} from ${path}Env or File` });
      continue;
    }
    if (recorded[name] !== stored[name]) {
      actions.push({ kind: "record", name, summary: `record the fingerprint of secret ${name} in the state` });
    }
  }
  return { actions, warnings };
}

/** The secret store's seal keys as the step plans with them: their kids and states, never a key. */
type SealKeyView = { readonly kid: string; readonly state: SealKeyState };

/**
 * Issues the first seal key of the Studio keyring and BRIDGE_SEAL_PUBLIC_KEY when the store never issued one. A store
 * that issued keys keeps them as they are, so a rotation's keys are never touched here.
 */
export function planSealKey(sealKeys: readonly SealKeyView[]): SecretAction[] {
  if (sealKeys.length > 0) return [];
  const summary = "issue the first seal key, for the Studio keyring and BRIDGE_SEAL_PUBLIC_KEY";
  return [{ kind: "seal-key", name: "seal-key", summary }];
}

/**
 * The seal key whose public half Platform receives as BRIDGE_SEAL_PUBLIC_KEY: the live key bridge.sealKeys.activeKid
 * names, or else the oldest live one, so a key issued later reaches Studio's keyring before Platform seals with it.
 */
export function platformSealKey<K extends SealKeyView>(sealKeys: readonly K[], activeKid?: string): K {
  return activeSealKey(sealKeys, activeKid);
}

/**
 * `stored` holds the fingerprint of every value in the store, and `recorded` the fingerprints in the state.
 * A secret the store lacks is generated; one whose fingerprint the state lacks or holds stale is recorded.
 */
export function planSecrets(
  names: readonly string[],
  stored: Readonly<Record<string, string>>,
  recorded: Readonly<Record<string, string>>,
): SecretAction[] {
  return names.flatMap((name): SecretAction[] => {
    if (stored[name] === undefined) return [{ kind: "generate", name, summary: `generate secret ${name}` }];
    if (recorded[name] !== stored[name]) {
      return [{ kind: "record", name, summary: `record the fingerprint of secret ${name} in the state` }];
    }
    return [];
  });
}
