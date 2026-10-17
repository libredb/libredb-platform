// What every step of the Docker graph receives: the configuration, the desired model, the adapters and the secret
// store, plus small helpers the steps share.
import { createHash } from "node:crypto";
import type { StepName } from "../engine/step";
import type { SecretStore } from "../secrets/store";
import type { InstallerState, OwnershipRecord } from "../state/store";
import { readOptionalFile } from "../adapters/host-fs";
import type { DockerPreflightContext } from "./preflight-docker";
import type { PostgresAdminAccess } from "./preflight-external";

export interface DockerContext extends DockerPreflightContext {
  secrets: SecretStore;
  /** `apply --renew-certificates`: the tls step re-issues every leaf and keeps the internal CA. */
  renewCertificates: boolean;
  /** Records a warning for the operator, which the run log keeps and the command prints after the run. */
  warn: (message: string) => void;
  /** Records a line in the run log only, such as the method and path of a Keycloak Admin API request. */
  info: (message: string) => void;
  /** The admin role of an external PostgreSQL server that the installer provisions; absent for any other server. */
  postgresAdmin?: PostgresAdminAccess;
}

/** The input hash the step recorded when it last succeeded, or undefined when it never did. */
export function recordedInputHash(state: InstallerState, step: StepName): string | undefined {
  const record = state.steps[step];
  return record === undefined || record.result === "failed" ? undefined : record.inputHash;
}

/** SHA-256 of a file's content, or null when the file does not exist yet. */
export function fileFingerprint(path: string): string | null {
  const content = readOptionalFile(path);
  return content === undefined ? null : createHash("sha256").update(content).digest("hex");
}

/** Records an object this installation created, once. */
export function recordOwnership(state: InstallerState, record: OwnershipRecord): void {
  const known = state.ownership.some(
    (entry) => entry.kind === record.kind && entry.name === record.name && entry.step === record.step,
  );
  if (!known) state.ownership.push(record);
}
