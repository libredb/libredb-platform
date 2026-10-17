// `tls export-ca`: writes the certificate of the internal CA, which issues the managed PostgreSQL leaf in every TLS mode
// and the public leaves in tls.mode generated, for the trust stores of browsers and database clients.
// It never reads or writes the CA's private key.
import { parseArgs } from "node:util";
import { readOptionalFile } from "../../adapters/host-fs";
import { OutputPathError, writeOutputFile } from "../../adapters/output-file";
import { INTERNAL_CA_FILES } from "../../docker/layout";
import { certificateToPem, parseCertificate } from "../../tls/inspect";
import { ExitCode } from "../exit-codes";
import type { Output } from "../main";

export const TLS_USAGE = `Usage: libredb-installer tls export-ca [-o <file> [--force]]

Writes the internal CA certificate as PEM to <file>, or to standard output without -o.
Clients that reach the managed PostgreSQL server, and in tls.mode generated every browser, trust this CA.
An existing <file> is replaced only with --force, and a symbolic link is replaced itself, never followed.
<file> must not contain a symbolic link, and every directory from / down must be owned by root, by the user that
runs the installer or by the operator who ran sudo, and be writable by its owner only, unless it is sticky as /tmp is.
`;

export function runTls(args: readonly string[], io: Output): ExitCode {
  const [subcommand, ...rest] = args;
  if (subcommand !== "export-ca") {
    io.stderr(`${subcommand === undefined ? "" : `tls: unknown subcommand '${subcommand}'\n\n`}${TLS_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  let output: string | undefined;
  let force: boolean;
  try {
    const { values } = parseArgs({
      args: rest,
      options: { output: { type: "string", short: "o" }, force: { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    });
    output = values.output;
    force = values.force === true;
  } catch (error) {
    io.stderr(`tls export-ca: ${(error as Error).message}\n\n${TLS_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  if (force && output === undefined) {
    io.stderr(`tls export-ca: --force needs --output (-o)\n\n${TLS_USAGE}`);
    return ExitCode.InvalidUsage;
  }
  try {
    const pem = readOptionalFile(INTERNAL_CA_FILES.certificate);
    if (pem === undefined) {
      io.stderr(`tls export-ca: ${INTERNAL_CA_FILES.certificate} does not exist, so apply the installation first\n`);
      return ExitCode.RuntimeFailure;
    }
    const certificate = certificateToPem(parseCertificate(pem, INTERNAL_CA_FILES.certificate));
    if (output === undefined) io.stdout(certificate);
    else writeOutputFile(output, certificate, { mode: 0o644, force });
    return ExitCode.Ok;
  } catch (error) {
    io.stderr(`tls export-ca: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof OutputPathError ? ExitCode.InvalidUsage : ExitCode.RuntimeFailure;
  }
}
