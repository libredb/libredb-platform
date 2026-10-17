// The fields an installation keeps for its whole life: once a step has applied an action they are recorded in
// the state, and a later run whose configuration changes one of them is refused with exit 6.
import { z } from "zod";
import { ExitCode } from "../cli/exit-codes";
import type { LibreDBInstallation } from "../config/schema";

/** The database and role names that provisioning creates once and never renames. */
export const POSTGRES_NAMES = {
  database: "libredb",
  keycloakDatabase: "keycloak",
  roles: {
    owner: "libredb_owner",
    platform: "libredb_platform",
    studio: "libredb_studio",
    keycloak: "libredb_keycloak",
  },
} as const;

export const IMMUTABLE_FIELDS = [
  "mode",
  "postgres.mode",
  "keycloak.mode",
  "keycloak.realm",
  "postgres.database",
  "postgres.keycloakDatabase",
  "postgres.roles.owner",
  "postgres.roles.platform",
  "postgres.roles.studio",
  "postgres.roles.keycloak",
] as const;

export type ImmutableField = (typeof IMMUTABLE_FIELDS)[number];

export type ImmutableFields = Readonly<Record<ImmutableField, string>>;

export const immutableFieldsSchema = z.record(z.enum(IMMUTABLE_FIELDS), z.string().min(1));

export function immutableFieldsOf(config: LibreDBInstallation): ImmutableFields {
  return {
    mode: config.mode,
    "postgres.mode": config.postgres.mode,
    "keycloak.mode": config.keycloak.mode,
    "keycloak.realm": config.keycloak.realm,
    "postgres.database": POSTGRES_NAMES.database,
    "postgres.keycloakDatabase": POSTGRES_NAMES.keycloakDatabase,
    "postgres.roles.owner": POSTGRES_NAMES.roles.owner,
    "postgres.roles.platform": POSTGRES_NAMES.roles.platform,
    "postgres.roles.studio": POSTGRES_NAMES.roles.studio,
    "postgres.roles.keycloak": POSTGRES_NAMES.roles.keycloak,
  };
}

export interface FieldChange {
  readonly field: ImmutableField;
  readonly recorded: string;
  readonly desired: string;
}

/** A configuration that changes a field the installation was created with. */
export class UnsafeChangeError extends Error {
  readonly exitCode = ExitCode.UnsafeChangeRefused;
  readonly changes: readonly FieldChange[];

  constructor(changes: readonly FieldChange[]) {
    super(
      [
        "refusing an unsafe change: these fields cannot change once the installation exists",
        ...changes.map(
          (change) => `  ${change.field}: ${change.recorded} when the installation was created, ${change.desired} now`,
        ),
      ].join("\n"),
    );
    this.name = "UnsafeChangeError";
    this.changes = changes;
  }
}

/** Throws UnsafeChangeError naming every field whose desired value differs from the recorded one. */
export function checkImmutable(recorded: ImmutableFields, desired: ImmutableFields): void {
  const changes = IMMUTABLE_FIELDS.filter((field) => recorded[field] !== desired[field]).map((field) => ({
    field,
    recorded: recorded[field],
    desired: desired[field],
  }));
  if (changes.length > 0) throw new UnsafeChangeError(changes);
}
