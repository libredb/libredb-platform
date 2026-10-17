import { beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { ExitCode } from "../../../src/cli/exit-codes";
import {
  checkExternalTls,
  EXTERNAL_TLS_PORT,
  EXTERNAL_TLS_SCRIPT,
  externalTlsProblems,
  parseExternalTlsProbe,
  type HostProbe,
} from "../../../src/preflight/external-tls";
import { PreflightError } from "../../../src/preflight/docker-checks";
import { createCa, type CertificateAuthority } from "../../../src/tls/ca";
import { LEAF_VALIDITY_DAYS, issueLeaf } from "../../../src/tls/leaf";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

let ca: CertificateAuthority;
let other: CertificateAuthority;

beforeAll(async () => {
  ca = await createCa({ commonName: "Corp root CA", now: at(-10) });
  other = await createCa({ commonName: "Somebody else's CA", now: at(-10) });
});

/** The probe of a host whose proxy presents `certPem`, as the probe script reports it: base64 DER, leaf first. */
const presenting = (host: string, ...pems: string[]): HostProbe => ({
  host,
  address: "10.0.0.5",
  chain: pems.map((pem) => new X509Certificate(pem).raw.toString("base64")),
});

function refusal(run: () => unknown): PreflightError {
  try {
    run();
  } catch (error) {
    if (error instanceof PreflightError) return error;
    throw error;
  }
  throw new Error("expected a PreflightError");
}

describe("external TLS preflight", () => {
  test("a public host whose certificate does not validate against the CA bundle fails with exit 3 naming the host", async () => {
    const good = (await issueLeaf(ca, ["platform.corp"], at(-1))).certPem;
    const foreign = (await issueLeaf(other, ["studio.corp"], at(-1))).certPem;
    const error = refusal(() =>
      checkExternalTls({
        probes: [presenting("platform.corp", good), presenting("studio.corp", foreign)],
        caBundlePem: ca.certPem,
        caBundleSource: "/etc/corp/ca.crt",
        now: NOW,
      }),
    );
    expect(error.exitCode).toBe(ExitCode.PreflightFailed);
    expect(error.problems).toEqual([
      "studio.corp presents a certificate on port 443 that does not validate against the CA bundle /etc/corp/ca.crt: " +
        "no certificate in the chain or the CA bundle issued CN=studio.corp",
    ]);
  });

  test("hosts that resolve and present a valid chain for themselves pass", async () => {
    const platform = (await issueLeaf(ca, ["platform.corp"], at(-1))).certPem;
    const studio = (await issueLeaf(ca, ["studio.corp", "auth.corp"], at(-1))).certPem;
    expect(() =>
      checkExternalTls({
        probes: [presenting("platform.corp", platform), presenting("studio.corp", studio), presenting("auth.corp", studio)],
        caBundlePem: ca.certPem,
        caBundleSource: "/etc/corp/ca.crt",
        now: NOW,
      }),
    ).not.toThrow();
    // The root the proxy sends along changes nothing.
    expect(
      externalTlsProblems([presenting("platform.corp", platform, ca.certPem)], ca.certPem, "ca.crt", NOW),
    ).toEqual([]);
  });

  test("names a host that does not resolve, one that cannot be reached, one not covered, an expired chain and an unreadable one", async () => {
    const studio = (await issueLeaf(ca, ["studio.corp"], at(-1))).certPem;
    const old = await createCa({ commonName: "Corp root CA", now: at(-2000) });
    const expiredLeaf = (await issueLeaf(old, ["auth.corp"], at(-LEAF_VALIDITY_DAYS - 1))).certPem;
    const problems = externalTlsProblems(
      [
        { host: "platform.corp", error: "getaddrinfo ENOTFOUND platform.corp" },
        { host: "studio.corp", address: "10.0.0.5", error: "connect ECONNREFUSED 10.0.0.5:443" },
        presenting("www.corp", studio),
        presenting("auth.corp", expiredLeaf),
        { host: "db.corp", address: "10.0.0.6", chain: ["!!"] },
        { host: "empty.corp", address: "10.0.0.7", chain: [] },
      ],
      `${ca.certPem}${old.certPem}`,
      "/etc/corp/ca.crt",
      NOW,
    );
    expect(problems[0]).toBe(
      "platform.corp does not resolve from inside the edge network: getaddrinfo ENOTFOUND platform.corp",
    );
    expect(problems[1]).toBe(
      "studio.corp (10.0.0.5) cannot be reached over TLS on port 443 from inside the edge network: " +
        "connect ECONNREFUSED 10.0.0.5:443",
    );
    expect(problems[2]).toBe("www.corp presents a certificate on port 443 that does not cover www.corp");
    expect(problems[3]).toStartWith(
      "auth.corp presents a certificate on port 443 that does not validate against the CA bundle /etc/corp/ca.crt: " +
        "CN=auth.corp expired on ",
    );
    expect(problems[4]).toStartWith("db.corp presents a chain that cannot be read: ");
    expect(problems[5]).toBe("empty.corp presents a chain that cannot be read: the probe returned no certificate");
    expect(problems).toHaveLength(6);
    expect(EXTERNAL_TLS_PORT).toBe(443);
  });

  test("an unreadable CA bundle is one problem", () => {
    expect(externalTlsProblems([], "not pem", "/etc/corp/ca.crt", NOW)).toEqual([
      "tls.caBundleFile: /etc/corp/ca.crt: no PEM certificate found",
    ]);
  });
});

describe("parseExternalTlsProbe", () => {
  test("reads the JSON line the probe script prints, one entry per host in order", () => {
    const stdout = `noise\n${JSON.stringify([
      { host: "platform.corp", address: "10.0.0.5", chain: ["AAAA"] },
      { host: "studio.corp", error: "getaddrinfo ENOTFOUND studio.corp" },
    ])}\n`;
    expect(parseExternalTlsProbe({ exitCode: 0, stdout, stderr: "" }, ["platform.corp", "studio.corp"])).toEqual([
      { host: "platform.corp", address: "10.0.0.5", chain: ["AAAA"] },
      { host: "studio.corp", error: "getaddrinfo ENOTFOUND studio.corp" },
    ]);
  });

  test("a failed probe, output that is not the expected JSON or other hosts are errors", () => {
    expect(() => parseExternalTlsProbe({ exitCode: 1, stdout: "", stderr: "boom\n" }, ["a.corp"])).toThrow(
      "the external TLS probe exited with 1: boom",
    );
    expect(() => parseExternalTlsProbe({ exitCode: 0, stdout: "{}\n", stderr: "" }, ["a.corp"])).toThrow(
      "the external TLS probe printed no result",
    );
    expect(() => parseExternalTlsProbe({ exitCode: 0, stdout: "[{\"host\": 1}]\n", stderr: "" }, ["a.corp"])).toThrow(
      "the external TLS probe printed no result",
    );
    expect(() =>
      parseExternalTlsProbe({ exitCode: 0, stdout: `${JSON.stringify([{ host: "b.corp", error: "x" }])}\n`, stderr: "" }, [
        "a.corp",
      ]),
    ).toThrow("the external TLS probe answered for b.corp where a.corp was asked");
  });

  test("the script reads the hosts from LIBREDB_HOSTS and resolves before it connects with each server name", () => {
    expect(EXTERNAL_TLS_SCRIPT).toContain("process.env.LIBREDB_HOSTS");
    expect(EXTERNAL_TLS_SCRIPT).toContain("lookup(host)");
    expect(EXTERNAL_TLS_SCRIPT).toContain("servername: host");
    expect(EXTERNAL_TLS_SCRIPT).toContain("rejectUnauthorized: false");
  });
});
