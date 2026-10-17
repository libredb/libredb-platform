// `status`: prints each step's last result, the run lock holder, the health of every container of the project and the
// days left of the internal CA and of every leaf on the host.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Docker } from "../../adapters/docker";
import { observePath, readOptionalFile } from "../../adapters/host-fs";
import { INTERNAL_CA_FILES } from "../../docker/layout";
import { formatStatus, type CertificateStatus } from "../../docker/report";
import { Redactor } from "../../log/redact";
import { EDGE_TLS_DIR } from "../../render/caddyfile";
import { COMPOSE_FILE, COMPOSE_PROJECT, POSTGRES_LEAF_FILES, POSTGRES_TLS_DIR } from "../../render/compose";
import { FileStateStore } from "../../state/file-store";
import { readLock } from "../../state/lock";
import { parseCertificates } from "../../tls/inspect";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";
import { DOCKER_STEPS, describeError, exitCodeOf } from "./docker-session";

export const STATUS_USAGE = `Usage: libredb-installer status

Prints each step's last result, who holds the run lock, the state and health of every container, and the days left
of the internal CA and of every leaf certificate.
`;

const CERTIFICATE_SUFFIX = ".crt";

/** The internal CA, each edge leaf by its hostname and the PostgreSQL leaf, as far as the host holds them. */
function installedCertificates(): CertificateStatus[] {
  const edge =
    observePath(EDGE_TLS_DIR) === undefined
      ? []
      : readdirSync(EDGE_TLS_DIR)
          .filter((name) => name.endsWith(CERTIFICATE_SUFFIX))
          .sort()
          .map((name) => ({ name: name.slice(0, -CERTIFICATE_SUFFIX.length), path: join(EDGE_TLS_DIR, name) }));
  const files = [
    { name: "internal CA", path: INTERNAL_CA_FILES.certificate },
    ...edge,
    { name: "postgres", path: join(POSTGRES_TLS_DIR, POSTGRES_LEAF_FILES.certificate) },
  ];
  return files.flatMap(({ name, path }) => {
    const pem = readOptionalFile(path);
    // A provided chain holds its intermediates after the leaf, whose expiry is the one shown.
    return pem === undefined ? [] : [{ name, notAfter: parseCertificates(pem, path)[0].validToDate }];
  });
}

export async function runStatus(args: readonly string[], io: Output): Promise<ExitCode> {
  if (args.length > 0) {
    io.stderr(`status: unexpected argument '${args[0]}'\n\n${STATUS_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  try {
    const state = await new FileStateStore().load();
    const docker = new Docker({ redactor: new Redactor(), log: () => {} });
    const containers =
      observePath(COMPOSE_FILE) === undefined
        ? undefined
        : await docker.ps({ project: COMPOSE_PROJECT, file: COMPOSE_FILE });
    io.stdout(
      formatStatus({
        steps: DOCKER_STEPS.map((step) => step.name),
        state,
        lock: readLock(),
        containers,
        certificates: installedCertificates(),
        now: new Date(),
      }),
    );
    return ExitCode.Ok;
  } catch (error) {
    io.stderr(`status: ${describeError(error)}\n`);
    return exitCodeOf(error);
  }
}
