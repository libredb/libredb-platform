// Customer secrets reach the installer only through `<key>Env` or `<key>File` references of the configuration.
// The installer reads one on each run that needs it and never persists it.

/** The `<key>Env` and `<key>File` references of one secret, named by its configuration path. */
export interface SecretReference {
  /** The configuration path of the secret without the suffix, such as postgres.external.adminPassword. */
  path: string;
  /** The name of the environment variable that holds the secret. */
  env?: string;
  /** The file that holds the secret. */
  file?: string;
}

/** Where a run looks for the secret. */
export interface SecretSources {
  env: Readonly<Record<string, string | undefined>>;
  /** Reads a file, or returns undefined when it does not exist. */
  readFile: (path: string) => string | undefined;
}

/** The secret, or why it is not supplied, as a phrase that never holds a value. */
export type SecretLookup = { value: string } | { missing: string };

/**
 * Reads a referenced secret. An unset or empty variable, and a missing or empty file, leave it unsupplied; a file loses
 * one trailing line break, which editors and `echo` add.
 */
export function readSecretReference(reference: SecretReference, sources: SecretSources): SecretLookup {
  if (reference.env !== undefined) {
    const value = sources.env[reference.env];
    if (value === undefined || value === "") {
      return { missing: `the environment variable ${reference.env} that ${reference.path}Env names is not set` };
    }
    return { value };
  }
  if (reference.file !== undefined) {
    const text = sources.readFile(reference.file);
    if (text === undefined) return { missing: `the file ${reference.file} that ${reference.path}File names does not exist` };
    const value = text.replace(/\r?\n$/, "");
    if (value === "") return { missing: `the file ${reference.file} that ${reference.path}File names is empty` };
    return { value };
  }
  return { missing: `neither ${reference.path}Env nor ${reference.path}File is set` };
}
