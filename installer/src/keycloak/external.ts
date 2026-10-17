// The admin access to an external Keycloak whose realm the installer reuses: the customer's
// credential, read from its *Env or *File reference on each run that needs it and never stored, and what a run
// without it may still do.
import type { AdminCredentials } from "../adapters/keycloak-admin";
import { ExitCode } from "../cli/exit-codes";
import type { ExternalKeycloak } from "../config/schema";

/** The public client of every realm through which an administrator signs in with a password. */
export const ADMIN_CLI = "admin-cli";

/** Where a credential reference is read: the installer's environment and the host's files. */
export interface CredentialSources {
  env: Readonly<Record<string, string | undefined>>;
  /** The content of a file, or undefined when it does not exist. */
  readFile: (path: string) => string | undefined;
}

/** The credential with its secret, which the caller registers with the redactor, or why this run has none. */
export type AdminCredentialLookup = { credentials: AdminCredentials; secret: string } | { missing: string };

/** A run that needs the customer's admin credential and was given none. */
export class MissingCredentialError extends Error {
  readonly exitCode = ExitCode.InvalidUsage;

  constructor(message: string) {
    super(message);
    this.name = "MissingCredentialError";
  }
}

// One secret through its two reference keys, `<key>Env` and `<key>File`, of which validation leaves exactly one set.
// A file's last line break is not part of the secret.
function readReference(
  key: string,
  env: string | undefined,
  file: string | undefined,
  sources: CredentialSources,
): { value: string } | { missing: string } {
  if (env !== undefined) {
    const value = sources.env[env];
    if (value === undefined || value === "") return { missing: `keycloak.external.${key}Env names ${env}, which is not set` };
    return { value };
  }
  if (file === undefined) throw new Error(`keycloak.external sets neither ${key}Env nor ${key}File`);
  const content = sources.readFile(file);
  if (content === undefined) return { missing: `keycloak.external.${key}File names ${file}, which does not exist` };
  const value = content.replace(/\r?\n$/, "");
  if (value === "") throw new Error(`${file}, which keycloak.external.${key}File names, is empty`);
  return { value };
}

/**
 * Reads the admin credential of keycloak.external: a confidential client of `adminRealm` with its secret, or a user of
 * `adminRealm` with its password, which signs in through admin-cli.
 */
export function lookupAdminCredentials(external: ExternalKeycloak, sources: CredentialSources): AdminCredentialLookup {
  const realm = external.adminRealm;
  if (external.provisioning !== "installer" || realm === undefined) {
    throw new Error("keycloak.external.provisioning is manual, so the installer uses no Keycloak admin credential");
  }
  if (external.adminClientId !== undefined) {
    const secret = readReference("adminClientSecret", external.adminClientSecretEnv, external.adminClientSecretFile, sources);
    if ("missing" in secret) return secret;
    return { credentials: { realm, clientId: external.adminClientId, clientSecret: secret.value }, secret: secret.value };
  }
  if (external.adminUser === undefined) throw new Error("keycloak.external sets neither adminClientId nor adminUser");
  const password = readReference("adminPassword", external.adminPasswordEnv, external.adminPasswordFile, sources);
  if ("missing" in password) return password;
  return {
    credentials: { realm, clientId: ADMIN_CLI, username: external.adminUser, password: password.value },
    secret: password.value,
  };
}

/**
 * The credential that `purpose` runs with, or the note of a skip. A run without the credential skips only while the
 * Keycloak inputs are unchanged since keycloak-configure last converged the realm, as for the unattended apply of a
 * renewal timer; any other run without it is refused with exit 2 naming the reference.
 */
export function adminAccess(
  lookup: AdminCredentialLookup,
  unchanged: boolean,
  purpose: string,
): { credentials: AdminCredentials } | { skipped: string } {
  if ("credentials" in lookup) return { credentials: lookup.credentials };
  if (unchanged) {
    return {
      skipped:
        `${purpose}: skipped, because ${lookup.missing}, and the Keycloak inputs are unchanged since ` +
        "keycloak-configure last converged the realm",
    };
  }
  throw new MissingCredentialError(
    `${lookup.missing}; ${purpose} needs the admin credential of the customer's Keycloak, which the installer reads on ` +
      "each run that changes the realm and never stores",
  );
}
