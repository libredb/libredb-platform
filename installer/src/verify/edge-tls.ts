// The edge TLS check of `verify`: every public endpoint the edge serves presents, under its own server
// name, a chain that validates against the CA bundle, covers the host and has at least 30 days left, which is when
// `apply` re-issues a generated leaf.
import { inspectChain } from "../tls/inspect";
import { RENEW_BEFORE_DAYS } from "../tls/plan";
import type { Check } from "./catalogue";
import { failed, PASSED } from "./platform";

/** A leaf with fewer days left than this fails edge-tls. */
export const EDGE_TLS_MIN_DAYS = RENEW_BEFORE_DAYS;

/** One public endpoint: the server name the client sends and the port the edge publishes it on. */
export interface EdgeEndpoint {
  host: string;
  port: number;
}

export interface EdgeTlsContext {
  /** Every endpoint the edge serves, in endpoint order. */
  endpoints: readonly EdgeEndpoint[];
  /** The CA bundle as PEM, the trust the apps start with. */
  readCaBundle: () => string;
  /** Connects to the endpoint's port with its server name and returns the chain it presents, leaf first, as PEM. */
  presentedChain: (endpoint: EdgeEndpoint) => Promise<string>;
  /** The installer's clock, in epoch milliseconds. */
  now: () => number;
}

type EdgeTlsChecks = { edgeTls: EdgeTlsContext };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function endpointProblem(context: EdgeTlsContext, endpoint: EdgeEndpoint, caBundlePem: string) {
  const name = `${endpoint.host}:${endpoint.port}`;
  let chainPem: string;
  try {
    chainPem = await context.presentedChain(endpoint);
  } catch (error) {
    return `${name} cannot be reached over TLS: ${messageOf(error)}`;
  }
  const report = inspectChain({
    chainPem,
    caBundlePem,
    hosts: [endpoint.host],
    now: new Date(context.now()),
    source: `the chain ${name} presents`,
  });
  if (report.chainProblem !== undefined) {
    return `${name} presents a chain that does not validate against the CA bundle: ${report.chainProblem}`;
  }
  if (report.uncovered.length > 0) return `${name} presents a certificate that does not cover ${endpoint.host}`;
  if (report.daysLeft < EDGE_TLS_MIN_DAYS) {
    return `${name} presents a certificate with ${report.daysLeft} days left, fewer than ${EDGE_TLS_MIN_DAYS}`;
  }
  return undefined;
}

/** edge-tls: every public endpoint presents a valid chain for its host with at least 30 days left. */
export const edgeTlsCheck: Check<EdgeTlsChecks> = {
  id: "edge-tls",
  async run({ edgeTls }) {
    const caBundlePem = edgeTls.readCaBundle();
    const problems: string[] = [];
    for (const endpoint of edgeTls.endpoints) {
      const problem = await endpointProblem(edgeTls, endpoint, caBundlePem);
      if (problem !== undefined) problems.push(problem);
    }
    return problems.length === 0 ? PASSED : failed(problems.join("; "));
  },
};
