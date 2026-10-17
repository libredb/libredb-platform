// tls.mode provided: the customer's chain and key per public endpoint, read through the *File references
// of the configuration and refused with exit 3 unless each key matches its certificate, each certificate covers its
// host and is within its validity, and each chain validates against tls.caBundleFile.
import type { LibreDBInstallation } from "../config/schema";
import type { Endpoint } from "../model/desired";
import { PreflightError } from "../preflight/docker-checks";
import { certificateToPem, inspectChain, parseCertificates, TlsError } from "./inspect";

/** One public endpoint the edge serves and the files of its provided chain and key. */
export interface ProvidedEndpoint {
  endpoint: Endpoint;
  host: string;
  certificateFile: string;
  keyFile: string;
}

/** A provided chain and key that passed every check, the chain re-encoded as canonical PEM. */
export interface ProvidedLeaf {
  endpoint: Endpoint;
  host: string;
  certPem: string;
  keyPem: string;
}

export interface LoadProvidedTlsInput {
  endpoints: readonly ProvidedEndpoint[];
  caBundleFile: string;
  readFile: (path: string) => string;
  now: Date;
}

const PREFIX = "tls.provided:";

/**
 * Pairs each site the edge serves with its configured files, in site order; empty outside tls.mode provided.
 * The schema already requires the files of every served site, so a missing pair is an Error.
 */
export function providedEndpoints(
  config: LibreDBInstallation,
  sites: readonly { endpoint: Endpoint; host: string }[],
): ProvidedEndpoint[] {
  const provided = config.tls.mode === "provided" ? config.tls.provided : undefined;
  if (provided === undefined) return [];
  return sites.map(({ endpoint, host }) => {
    const files = provided[endpoint];
    if (files === undefined) {
      throw new Error(`tls.provided.${endpoint}: no certificateFile and keyFile for ${host}, which the edge serves`);
    }
    return { endpoint, host, certificateFile: files.certificateFile, keyFile: files.keyFile };
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a file, or records why it cannot be read and returns undefined. */
function readOrRecord(input: LoadProvidedTlsInput, path: string, what: string, problems: string[]): string | undefined {
  try {
    return input.readFile(path);
  } catch (error) {
    problems.push(`${PREFIX} cannot read ${what}: ${messageOf(error)}`);
    return undefined;
  }
}

/**
 * Loads and checks every provided chain and key. Every problem is collected, and the hosts that no certificate covers
 * close the list as one line, so one run names everything the operator has to fix; any problem is a PreflightError
 * (exit 3). An error that is not about the TLS material is thrown as it is.
 */
export function loadProvidedTls(input: LoadProvidedTlsInput): ProvidedLeaf[] {
  const problems: string[] = [];
  const bundlePem = readOrRecord(input, input.caBundleFile, `tls.caBundleFile ${input.caBundleFile}`, problems);
  if (bundlePem === undefined) throw new PreflightError(problems);
  try {
    parseCertificates(bundlePem, input.caBundleFile);
  } catch (error) {
    if (!(error instanceof TlsError)) throw error;
    throw new PreflightError([`${PREFIX} ${error.message}`]);
  }
  const uncovered: string[] = [];
  const leaves: ProvidedLeaf[] = [];
  for (const endpoint of input.endpoints) {
    const chainPem = readOrRecord(input, endpoint.certificateFile, endpoint.certificateFile, problems);
    const keyPem = readOrRecord(input, endpoint.keyFile, endpoint.keyFile, problems);
    if (chainPem === undefined || keyPem === undefined) continue;
    let report;
    let certPem: string;
    try {
      certPem = parseCertificates(chainPem, endpoint.certificateFile).map(certificateToPem).join("");
      report = inspectChain({
        chainPem,
        keyPem,
        caBundlePem: bundlePem,
        hosts: [endpoint.host],
        now: input.now,
        source: endpoint.certificateFile,
      });
    } catch (error) {
      if (!(error instanceof TlsError)) throw error;
      // inspectChain names the key `<certificateFile> key`; name the key file instead.
      problems.push(`${PREFIX} ${error.message.replace(`${endpoint.certificateFile} key:`, `${endpoint.keyFile}:`)}`);
      continue;
    }
    const before = problems.length;
    if (report.keyMatches === false) {
      problems.push(`${PREFIX} the key in ${endpoint.keyFile} does not match the certificate in ${endpoint.certificateFile}`);
    }
    if (report.expired) {
      problems.push(`${PREFIX} the certificate in ${endpoint.certificateFile} expired on ${report.notAfter.toISOString()}`);
    } else if (report.chainProblem !== undefined) {
      problems.push(
        `${PREFIX} the chain in ${endpoint.certificateFile} does not validate against tls.caBundleFile ` +
          `${input.caBundleFile}: ${report.chainProblem}`,
      );
    }
    uncovered.push(...report.uncovered);
    if (problems.length === before && report.uncovered.length === 0) {
      leaves.push({ endpoint: endpoint.endpoint, host: endpoint.host, certPem, keyPem });
    }
  }
  if (uncovered.length > 0) problems.push(`${PREFIX} certificate does not cover ${uncovered.join(", ")}`);
  if (problems.length > 0) throw new PreflightError(problems);
  return leaves;
}
