// The external TLS preflight: in `tls.mode: external` the edge holds no hostname alias, so containers
// reach the public issuer and app URLs through the customer's upstream proxy. Every public host must therefore resolve
// from inside the edge network and present on 443 a certificate for itself that validates against tls.caBundleFile.
// A probe script runs in a one-shot container on that network and reports what it saw; this module judges it.
import { X509Certificate } from "node:crypto";
import { z } from "zod";
import { certificateToPem, inspectChain, parseCertificates, TlsError } from "../tls/inspect";
import type { ProbeResult } from "../verify/platform";
import { PreflightError } from "./docker-checks";

/** The port the upstream proxy terminates TLS on for every public URL. */
export const EXTERNAL_TLS_PORT = 443;

/**
 * Resolves each host of LIBREDB_HOSTS, connects to it on 443 with its server name and prints one JSON line: per host
 * its address and the chain it presents as base64 DER, leaf first, or the error of the stage that failed. It does not
 * verify the chain, so the installer can say why one does not validate. It holds no `$`.
 */
export const EXTERNAL_TLS_SCRIPT = `
import { lookup } from "node:dns/promises";
import { connect } from "node:tls";
const hosts = JSON.parse(process.env.LIBREDB_HOSTS);
const port = ${EXTERNAL_TLS_PORT};
function chainOf(host, address) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, servername: host, rejectUnauthorized: false });
    socket.setTimeout(10000, () => socket.destroy(new Error("no TLS handshake within 10 s")));
    socket.once("secureConnect", () => {
      const seen = new Set();
      const chain = [];
      for (let current = socket.getPeerCertificate(true); current && current.raw && !seen.has(current.fingerprint256); current = current.issuerCertificate) {
        seen.add(current.fingerprint256);
        chain.push(current.raw.toString("base64"));
      }
      socket.end();
      resolve(chain);
    });
    socket.once("error", reject);
  });
}
const results = [];
for (const host of hosts) {
  let address;
  try {
    address = (await lookup(host)).address;
  } catch (error) {
    results.push({ host, error: error.message });
    continue;
  }
  try {
    results.push({ host, address, chain: await chainOf(host, address) });
  } catch (error) {
    results.push({ host, address, error: error.message });
  }
}
process.stdout.write(JSON.stringify(results) + "\\n");
`;

/** What the probe saw for one host: no address when it did not resolve, and a chain or the error of the handshake. */
export interface HostProbe {
  host: string;
  address?: string;
  chain?: string[];
  error?: string;
}

const hostProbe = z
  .object({
    host: z.string(),
    address: z.string().optional(),
    chain: z.array(z.string()).optional(),
    error: z.string().optional(),
  })
  .strict();

/** Reads the probe's JSON line, which must answer for exactly the hosts asked, in order. */
export function parseExternalTlsProbe(result: ProbeResult, hosts: readonly string[]): HostProbe[] {
  if (result.exitCode !== 0) {
    throw new Error(`the external TLS probe exited with ${result.exitCode}: ${result.stderr.trim()}`);
  }
  const line = result.stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("["));
  const parsed = z.array(hostProbe).safeParse(line === undefined ? undefined : JSON.parse(line));
  if (!parsed.success) throw new Error("the external TLS probe printed no result");
  parsed.data.forEach((probe, index) => {
    if (probe.host !== hosts[index]) {
      throw new Error(`the external TLS probe answered for ${probe.host} where ${hosts[index]} was asked`);
    }
  });
  return parsed.data;
}

function chainPemOf(chain: readonly string[]): string {
  if (chain.length === 0) throw new TlsError("the probe returned no certificate");
  return chain.map((der) => certificateToPem(new X509Certificate(Buffer.from(der, "base64")))).join("");
}

function hostProblem(probe: HostProbe, caBundlePem: string, caBundleSource: string, now: Date): string | undefined {
  const { host } = probe;
  if (probe.address === undefined) return `${host} does not resolve from inside the edge network: ${probe.error}`;
  if (probe.chain === undefined) {
    return (
      `${host} (${probe.address}) cannot be reached over TLS on port ${EXTERNAL_TLS_PORT} from inside the edge network: ` +
      `${probe.error}`
    );
  }
  let chainPem: string;
  try {
    chainPem = chainPemOf(probe.chain);
  } catch (error) {
    return `${host} presents a chain that cannot be read: ${(error as Error).message}`;
  }
  const report = inspectChain({ chainPem, caBundlePem, hosts: [host], now, source: `the chain ${host} presents` });
  const on = `on port ${EXTERNAL_TLS_PORT}`;
  if (report.chainProblem !== undefined) {
    return (
      `${host} presents a certificate ${on} that does not validate against the CA bundle ${caBundleSource}: ` +
      report.chainProblem
    );
  }
  if (report.uncovered.length > 0) return `${host} presents a certificate ${on} that does not cover ${host}`;
  return undefined;
}

/** One line per public host that does not resolve or does not present a valid chain for itself, in host order. */
export function externalTlsProblems(
  probes: readonly HostProbe[],
  caBundlePem: string,
  caBundleSource: string,
  now: Date,
): string[] {
  try {
    parseCertificates(caBundlePem, caBundleSource);
  } catch (error) {
    return [`tls.caBundleFile: ${(error as Error).message}`];
  }
  return probes.flatMap((probe) => hostProblem(probe, caBundlePem, caBundleSource, now) ?? []);
}

export interface ExternalTlsInput {
  probes: readonly HostProbe[];
  caBundlePem: string;
  caBundleSource: string;
  now: Date;
}

/** Throws PreflightError (exit 3) naming every public host that fails the external TLS preflight. */
export function checkExternalTls(input: ExternalTlsInput): void {
  const problems = externalTlsProblems(input.probes, input.caBundlePem, input.caBundleSource, input.now);
  if (problems.length > 0) throw new PreflightError(problems);
}
