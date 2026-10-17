// Reads the certificate chain a TLS server presents for a server name, without trusting it: the edge-tls check
// validates the chain itself against the CA bundle (src/verify/edge-tls.ts).
import { X509Certificate } from "node:crypto";
import { connect, type DetailedPeerCertificate } from "node:tls";
import { certificateToPem } from "../tls/inspect";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface PresentedChainRequest {
  /** The address the port is published on, such as 127.0.0.1. */
  address: string;
  port: number;
  /** The server name the client sends, which selects the site and its certificate. */
  servername: string;
  timeoutMs?: number;
}

/**
 * The chain as PEM, leaf first, then the certificates the server presented after it, which Bun reports through
 * issuerCertificate as Node does. test/unit/verify/edge-tls.test.ts checks that a leaf from an intermediate the server
 * presents validates against a CA bundle that holds only the root.
 */
function chainPem(peer: DetailedPeerCertificate): string {
  const seen = new Set<string>();
  let pem = "";
  for (let current: DetailedPeerCertificate | undefined = peer; current?.raw !== undefined; current = current.issuerCertificate) {
    if (seen.has(current.fingerprint256)) break;
    seen.add(current.fingerprint256);
    pem += certificateToPem(new X509Certificate(current.raw));
  }
  return pem;
}

export function presentedChain(request: PresentedChainRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: request.address,
      port: request.port,
      servername: request.servername,
      // The check validates the chain against the CA bundle itself, so it can say why one does not validate.
      rejectUnauthorized: false,
    });
    socket.setTimeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      socket.destroy(new Error(`no TLS handshake within ${(request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} s`));
    });
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate(true);
      socket.end();
      if (peer.raw === undefined) reject(new Error("the server presented no certificate"));
      else resolve(chainPem(peer));
    });
    socket.once("error", reject);
  });
}
