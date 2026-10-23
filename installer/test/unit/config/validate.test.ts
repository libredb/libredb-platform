import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { main, type Output } from "../../../src/cli/main";
import { ExitCode } from "../../../src/cli/exit-codes";
import { readConfigDocument } from "../../../src/config/load";
import { ConfigError, findInlineSecrets, parseInstallation } from "../../../src/config/schema";

const root = join(import.meta.dir, "..", "..", "..");
const fixture = (name: string) => join(root, "test", "fixtures", "configs", name);
const golden = (name: string) => readFileSync(join(root, "test", "golden", name), "utf8");

// A value of the license token's shape that no key signed, which the installer must never print.
const LICENSE_TOKEN = ["ldl1", "0123456789abcdef", Buffer.from('{"v":1}').toString("base64url"), Buffer.alloc(64).toString("base64url")].join(".");

// The path of the license file in the configurations below; validate never reads it.
const LICENSE_FILE = "/etc/libredb/platform.license";

const LICENSE_REQUIRED =
  "platform.licenseFile: every install needs a license file from LibreDB, the free license included, so request one " +
  "at info@libredb.org as docs/deploy/install-docker.md#request-a-license describes and name its path here";

const scratch = mkdtempSync(join(tmpdir(), "libredb-validate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** docker-minimal.yaml without platform.licenseFile, written to a file of its own. */
function unlicensedFixture(): string {
  const document = readConfigDocument(fixture("docker-minimal.yaml"));
  const { licenseFile: _licenseFile, ...platform } = document.platform as Record<string, unknown>;
  const path = join(scratch, "unlicensed.yaml");
  writeFileSync(path, stringify({ ...document, platform }));
  return path;
}

function capture(): Output & { out: string; err: string } {
  const sink = {
    out: "",
    err: "",
    stdout(text: string) {
      sink.out += text;
    },
    stderr(text: string) {
      sink.err += text;
    },
  };
  return sink;
}

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: "install.libredb.org/v1",
    kind: "LibreDBInstallation",
    metadata: { name: "acme" },
    mode: "docker",
    endpoints: {
      hosts: { platform: "platform.corp", studio: "studio.corp", auth: "auth.corp" },
    },
    platform: { organizationName: "Acme", licenseFile: LICENSE_FILE },
    ...overrides,
  };
}

function issuesOf(raw: unknown): string[] {
  try {
    parseInstallation(raw);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("validate command", () => {
  test("rejects an inline postgres.external.adminPassword with exit 2 and the message 'inline secrets are not allowed, use adminPasswordEnv or adminPasswordFile'", async () => {
    const io = capture();
    const code = await main(["validate", "-c", fixture("inline-secret.yaml")], io);
    expect(code).toBe(ExitCode.InvalidUsage);
    expect(code).toBe(2);
    expect(io.out).toBe("");
    expect(io.err).toContain(
      "postgres.external.adminPassword: inline secrets are not allowed, use adminPasswordEnv or adminPasswordFile",
    );
    expect(io.err).not.toContain("hunter2-inline");
  });

  test("rejects an unknown endpoints.style with exit 2 naming the allowed values", async () => {
    const io = capture();
    const code = await main(["validate", "-c", fixture("unknown-style.yaml")], io);
    expect(code).toBe(2);
    expect(io.out).toBe("");
    expect(io.err).toContain("endpoints.style:");
    expect(io.err).toContain('"hostnames"');
  });

  test("rejects endpoints.style ports in kubernetes mode with exit 2", async () => {
    const io = capture();
    const code = await main(["validate", "-c", fixture("ports-in-kubernetes.yaml")], io);
    expect(code).toBe(2);
    expect(io.out).toBe("");
    expect(io.err).toContain("endpoints.style: the ports style is allowed only in docker mode");
  });

  test("rejects the ports style with two equal ports with exit 2", async () => {
    const io = capture();
    const code = await main(
      ["validate", "-c", fixture("docker-ports.yaml"), "--set", "endpoints.ports.auth=8443"],
      io,
    );
    expect(code).toBe(2);
    expect(io.out).toBe("");
    expect(io.err).toContain(
      "endpoints.ports.auth: the ports style needs a distinct port per endpoint, and 8443 is also used by studio",
    );
  });

  test("rejects tls.mode external without tls.external.trustedProxies with exit 2 naming the field", async () => {
    const io = capture();
    const code = await main(
      ["validate", "-c", fixture("docker-minimal.yaml"), "--set", "tls.mode=external", "--set", "tls.caBundleFile=/etc/corp/ca.crt"],
      io,
    );
    expect(code).toBe(2);
    expect(io.out).toBe("");
    expect(io.err).toContain(
      "tls.external.trustedProxies: must list the upstream proxy's addresses as CIDR ranges, such as 192.0.2.10/32, " +
        "because the edge trusts X-Forwarded-* headers only from them",
    );
  });

  test("prints docker-ports.yaml normalized with the ports style", async () => {
    const io = capture();
    const code = await main(["validate", "-c", fixture("docker-ports.yaml")], io);
    expect(io.err).toBe("");
    expect(code).toBe(ExitCode.Ok);
    expect(io.out).toContain(
      "endpoints:\n  style: ports\n  host: lab.libredb.test\n  ports:\n    platform: 443\n    studio: 8443\n    auth: 9443\n",
    );
  });

  test("prints docker-minimal.yaml normalized exactly as test/golden/docker-minimal.normalized.yaml", async () => {
    const io = capture();
    const code = await main(["validate", "-c", fixture("docker-minimal.yaml")], io);
    expect(io.err).toBe("");
    expect(code).toBe(ExitCode.Ok);
    expect(io.out).toBe(golden("docker-minimal.normalized.yaml"));
  });

  test("applies repeatable --set overrides after the file", async () => {
    const io = capture();
    const code = await main(
      [
        "validate",
        "--config",
        fixture("docker-minimal.yaml"),
        "--set",
        "docker.systemdUnit=true",
        "--set",
        "keycloak.adminPort=18443",
      ],
      io,
    );
    expect(io.err).toBe("");
    expect(code).toBe(0);
    expect(io.out).toContain("systemdUnit: true");
    expect(io.out).toContain("adminPort: 18443");
  });

  test("an inline secret given through --set is refused too", async () => {
    const io = capture();
    const code = await main(
      ["validate", "-c", fixture("docker-minimal.yaml"), "--set", "network.proxyPassword=hunter2"],
      io,
    );
    expect(code).toBe(2);
    expect(io.err).toContain("network.proxyPassword: inline secrets are not allowed, use proxyPasswordEnv or proxyPasswordFile");
    expect(io.err).not.toContain("hunter2");
  });

  test("accepts platform.licenseFile and prints its path in the normalized configuration", async () => {
    const io = capture();
    const code = await main(
      ["validate", "-c", fixture("docker-minimal.yaml"), "--set", "platform.licenseFile=/root/libredb.license"],
      io,
    );
    expect(io.err).toBe("");
    expect(code).toBe(ExitCode.Ok);
    expect(io.out).toContain("platform:\n  organizationName: Acme Corp\n  licenseFile: /root/libredb.license\n");
  });

  test("refuses a configuration without platform.licenseFile with exit 2, naming the license request, and so do the other commands that read it", async () => {
    const unlicensed = unlicensedFixture();
    const io = capture();
    expect(await main(["validate", "-c", unlicensed], io)).toBe(ExitCode.InvalidUsage);
    expect({ out: io.out, err: io.err }).toEqual({ out: "", err: `invalid configuration:\n  ${LICENSE_REQUIRED}\n` });
    for (const argv of [
      ["images", "list", "-c", unlicensed],
      ["keycloak", "console", "-c", unlicensed],
      ["keycloak", "export", "-c", unlicensed, "-o", join(scratch, "keycloak-export")],
    ]) {
      const refused = capture();
      expect({ argv, code: await main(argv, refused), out: refused.out }).toEqual({ argv, code: ExitCode.InvalidUsage, out: "" });
      expect(refused.err).toContain(LICENSE_REQUIRED);
    }
  });

  test("refuses a license token written inline, under platform.license or in place of the path of platform.licenseFile, and never prints it", async () => {
    const refusals = [
      { set: `platform.license=${LICENSE_TOKEN}`, issue: "platform.license: inline license tokens are not allowed, use licenseFile" },
      {
        set: `platform.licenseFile=${LICENSE_TOKEN}`,
        issue: "platform.licenseFile: expected the path of the file that holds the license token, not the token itself",
      },
    ];
    for (const { set, issue } of refusals) {
      const io = capture();
      const code = await main(["validate", "-c", fixture("docker-minimal.yaml"), "--set", set], io);
      expect({ code, out: io.out }).toEqual({ code: ExitCode.InvalidUsage, out: "" });
      expect(io.err).toContain(issue);
      expect(io.err).not.toContain(LICENSE_TOKEN);
    }
  });

  test("without --config exits 2 with the usage", async () => {
    const io = capture();
    const code = await main(["validate"], io);
    expect(code).toBe(2);
    expect(io.err).toContain("--config");
  });

  test("an unknown option exits 2", async () => {
    const io = capture();
    const code = await main(["validate", "-c", fixture("docker-minimal.yaml"), "--frobnicate"], io);
    expect(code).toBe(2);
    expect(io.err).toContain("frobnicate");
  });

  test("a missing config file exits 2 naming the file", async () => {
    const io = capture();
    const code = await main(["validate", "-c", fixture("does-not-exist.yaml")], io);
    expect(code).toBe(2);
    expect(io.err).toContain("does-not-exist.yaml");
  });
});

describe("schema", () => {
  test("a minimal docker installation takes every default", () => {
    const config = parseInstallation(minimal());
    expect(config).toEqual({
      apiVersion: "install.libredb.org/v1",
      kind: "LibreDBInstallation",
      metadata: { name: "acme" },
      mode: "docker",
      endpoints: {
        style: "hostnames",
        hosts: { platform: "platform.corp", studio: "studio.corp", auth: "auth.corp" },
      },
      tls: { mode: "generated" },
      postgres: { mode: "managed" },
      keycloak: {
        mode: "managed",
        realm: "libredb",
        adminPort: 18080,
        firstAdmin: { enabled: true, username: "libredb-admin" },
        userManager: { enabled: true, username: "libredb-user-manager" },
      },
      platform: { organizationName: "Acme", licenseFile: LICENSE_FILE },
      backups: { enabled: true },
      bridge: { sealKeys: { issueNew: false, retire: [] } },
      docker: { systemdUnit: false },
    });
  });

  test("bridge.sealKeys takes kids of 16 lowercase hex digits, each retired once", () => {
    const sealKeys = (fields: Record<string, unknown>) => () => parseInstallation(minimal({ bridge: { sealKeys: fields } }));
    expect(sealKeys({ issueNew: true, activeKid: "0123456789abcdef", retire: ["fedcba9876543210"] })().bridge).toEqual({
      sealKeys: { issueNew: true, activeKid: "0123456789abcdef", retire: ["fedcba9876543210"] },
    });
    expect(sealKeys({ activeKid: "0123456789ABCDEF" })).toThrow("bridge.sealKeys.activeKid: expected a seal key id");
    expect(sealKeys({ retire: ["0123456789abcdef", "0123456789abcdef"] })).toThrow(
      "bridge.sealKeys.retire: expected distinct kids",
    );
  });

  test("a minimal kubernetes installation gets the kubernetes defaults and no docker section", () => {
    const config = parseInstallation(minimal({ mode: "kubernetes" }));
    expect(config.mode).toBe("kubernetes");
    if (config.mode !== "kubernetes") throw new Error("unreachable");
    expect(config.kubernetes).toEqual({ namespace: "libredb", createNamespace: false, exposure: "ingress" });
    expect("docker" in config).toBe(false);
  });

  test("keeps the optional sections when they are set", () => {
    const config = parseInstallation(
      minimal({
        tls: {
          mode: "provided",
          caBundleFile: "/etc/pki/corp-ca.pem",
          provided: {
            platform: { certificateFile: "/etc/pki/platform.crt", keyFile: "/etc/pki/platform.key" },
            studio: { certificateFile: "/etc/pki/studio.crt", keyFile: "/etc/pki/studio.key" },
          },
        },
        postgres: { mode: "external", external: { host: "db.corp", adminUser: "dba" } },
        keycloak: {
          mode: "external",
          realm: "corp",
          adminPort: 28080,
          firstAdmin: { username: "dba" },
          external: { baseUrl: "https://auth.corp", adminClientId: "provisioner", adminClientSecretEnv: "KC_SECRET" },
        },
        images: { registry: "harbor.corp:8443/libredb" },
        network: { httpsProxy: "http://proxy.corp:3128" },
        backups: { enabled: false },
        docker: { systemdUnit: true },
      }),
    );
    expect(config.tls).toEqual({
      mode: "provided",
      caBundleFile: "/etc/pki/corp-ca.pem",
      provided: {
        platform: { certificateFile: "/etc/pki/platform.crt", keyFile: "/etc/pki/platform.key" },
        studio: { certificateFile: "/etc/pki/studio.crt", keyFile: "/etc/pki/studio.key" },
      },
    });
    expect(config.keycloak).toEqual({
      mode: "external",
      realm: "corp",
      adminPort: 28080,
      firstAdmin: { enabled: false, username: "dba" },
      userManager: { enabled: false, username: "libredb-user-manager" },
      external: {
        baseUrl: "https://auth.corp",
        provisioning: "installer",
        adminRealm: "master",
        adminClientId: "provisioner",
        adminClientSecretEnv: "KC_SECRET",
      },
    });
    expect(config.images).toEqual({ registry: "harbor.corp:8443/libredb" });
    expect(config.network).toEqual({ httpsProxy: "http://proxy.corp:3128" });
    expect(config.backups).toEqual({ enabled: false });
  });

  test("refuses a kubernetes section in docker mode and a docker section in kubernetes mode", () => {
    expect(issuesOf(minimal({ kubernetes: { namespace: "x" } }))).toEqual([
      '(root): Unrecognized key: "kubernetes"',
    ]);
    expect(issuesOf(minimal({ mode: "kubernetes", docker: { systemdUnit: true } }))).toEqual([
      '(root): Unrecognized key: "docker"',
    ]);
  });

  test("refuses an unknown mode naming the allowed values", () => {
    const issues = issuesOf(minimal({ mode: "nomad" }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toStartWith("mode: ");
    expect(issues[0]).toContain('"docker"');
    expect(issues[0]).toContain('"kubernetes"');
  });

  test("refuses a wrong apiVersion and kind", () => {
    const issues = issuesOf(minimal({ apiVersion: "install.libredb.org/v2", kind: "Installation" }));
    expect(issues.some((issue) => issue.startsWith("apiVersion: "))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("kind: "))).toBe(true);
  });

  test("refuses an unknown apiVersion naming the supported one", () => {
    expect(issuesOf(minimal({ apiVersion: "install.libredb.org/v2" }))).toEqual([
      'apiVersion: Invalid input: expected "install.libredb.org/v1"',
    ]);
  });

  test("refuses two endpoints on the same host in the hostnames style", () => {
    const issues = issuesOf(
      minimal({ endpoints: { hosts: { platform: "lab.corp", studio: "lab.corp", auth: "auth.corp" } } }),
    );
    expect(issues).toEqual([
      "endpoints.hosts.studio: the hostnames style needs a distinct host per endpoint, and lab.corp is also used by platform",
    ]);
  });

  test("the ports style takes the default ports and needs a host", () => {
    const config = parseInstallation(minimal({ endpoints: { style: "ports", host: "lab.corp" } }));
    expect(config.endpoints).toEqual({
      style: "ports",
      host: "lab.corp",
      ports: { platform: 443, studio: 8443, auth: 9443 },
    });
    expect(issuesOf(minimal({ endpoints: { style: "ports" } }))).toEqual([
      "endpoints.host: Invalid input: expected string, received undefined",
    ]);
  });

  test("refuses hosts in the ports style and a host in the hostnames style", () => {
    expect(issuesOf(minimal({ endpoints: { style: "ports", host: "lab.corp", hosts: {} } }))).toEqual([
      'endpoints: Unrecognized key: "hosts"',
    ]);
    expect(
      issuesOf(
        minimal({
          endpoints: { host: "lab.corp", hosts: { platform: "p.corp", studio: "s.corp", auth: "a.corp" } },
        }),
      ),
    ).toEqual(['endpoints: Unrecognized key: "host"']);
  });

  test("refuses the ports style with an external Keycloak, which serves its own host", () => {
    expect(
      issuesOf(minimal({ endpoints: { style: "ports", host: "lab.corp" }, keycloak: { mode: "external", external: { baseUrl: "https://auth.corp", adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD" } } })),
    ).toEqual([
      "endpoints.style: the ports style serves Keycloak on the one host, so it needs keycloak.mode managed",
    ]);
  });

  test("refuses the ports style with tls.mode provided or external, which need a host per endpoint", () => {
    const files = { certificateFile: "/c/p.crt", keyFile: "/c/p.key" };
    expect(
      issuesOf(
        minimal({
          endpoints: { style: "ports", host: "lab.corp" },
          tls: { mode: "provided", caBundleFile: "/c/ca.crt", provided: { platform: files, studio: files, auth: files } },
        }),
      ),
    ).toEqual([
      "tls.mode: the ports style serves every endpoint on one host with one generated leaf, so it needs tls.mode generated, not provided",
    ]);
    const external = { mode: "external", caBundleFile: "/c/ca.crt", external: { trustedProxies: ["192.0.2.10/32"] } };
    expect(issuesOf(minimal({ endpoints: { style: "ports", host: "lab.corp" }, tls: external }))).toEqual([
      "tls.mode: the ports style serves every endpoint on one host with one generated leaf, so it needs tls.mode generated, not external",
    ]);
  });

  test("refuses an invalid hostname, metadata name, registry, proxy URL and port", () => {
    const issues = issuesOf(
      minimal({
        metadata: { name: "Acme Corp" },
        endpoints: { hosts: { platform: "https://platform.corp", studio: "studio.corp", auth: "auth.corp" } },
        images: { registry: "https://harbor.corp/" },
        network: { httpsProxy: "ftp://proxy.corp" },
        keycloak: { adminPort: 70000 },
      }),
    );
    const paths = issues.map((issue) => issue.slice(0, issue.indexOf(":")));
    expect(paths).toEqual([
      "metadata.name",
      "endpoints.hosts.platform",
      "keycloak.adminPort",
      "images.registry",
      "network.httpsProxy",
    ]);
  });

  test("refuses unknown keys so that a typo does not pass silently", () => {
    expect(issuesOf(minimal({ tls: { mode: "generated", caBundle: "/x.pem" } }))).toEqual([
      'tls: Unrecognized key: "caBundle"',
    ]);
  });

  test("refuses a missing organization name", () => {
    expect(issuesOf(minimal({ platform: { licenseFile: LICENSE_FILE } }))).toEqual([
      "platform.organizationName: Invalid input: expected string, received undefined",
    ]);
  });

  test("refuses a configuration without platform.licenseFile in every mode, because every install needs a license file from LibreDB", () => {
    for (const mode of ["docker", "kubernetes"]) {
      // An empty value in YAML, such as `licenseFile:`, or an empty --set value, is null, and `licenseFile: ""` or
      // --set 'platform.licenseFile=""' is the empty string.
      for (const platform of [
        { organizationName: "Acme" },
        { organizationName: "Acme", licenseFile: null },
        { organizationName: "Acme", licenseFile: "" },
      ]) {
        expect({ mode, platform, issues: issuesOf(minimal({ mode, platform })) }).toEqual({
          mode,
          platform,
          issues: [LICENSE_REQUIRED],
        });
      }
    }
  });

  test("refuses a document that is not a mapping", () => {
    expect(issuesOf(["a"])).toEqual(["(root): Invalid input: expected object, received array"]);
  });
});

/** A reused realm of the customer's Keycloak at the minimal configuration's auth host, plus keycloak fields. */
function externalKeycloak(fields: Record<string, unknown> = {}, external: Record<string, unknown> = {}) {
  return {
    mode: "external",
    ...fields,
    external: { baseUrl: "https://auth.corp", adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD", ...external },
  };
}

describe("external PostgreSQL", () => {
  const external = (fields: Record<string, unknown>) => minimal({ postgres: { mode: "external", external: fields } });

  test("takes the server, the admin role and a reference to its password, with port 5432 and provisioning installer by default", () => {
    const config = parseInstallation(
      external({
        host: "pg.corp.example",
        adminUser: "corp_dba",
        adminPasswordEnv: "LIBREDB_PG_ADMIN_PASSWORD",
        caBundleFile: "/etc/pki/corp-db-ca.pem",
      }),
    );
    expect(config.postgres).toEqual({
      mode: "external",
      external: {
        host: "pg.corp.example",
        port: 5432,
        adminUser: "corp_dba",
        adminPasswordEnv: "LIBREDB_PG_ADMIN_PASSWORD",
        caBundleFile: "/etc/pki/corp-db-ca.pem",
        provisioning: "installer",
      },
    });
    expect(parseInstallation(external({ host: "db", port: 6432, adminUser: "dba", adminPasswordFile: "/root/pg" })).postgres).toEqual({
      mode: "external",
      external: { host: "db", port: 6432, adminUser: "dba", adminPasswordFile: "/root/pg", provisioning: "installer" },
    });
  });

  test("refuses an IP address, which Platform and Studio cannot verify with verify-full", () => {
    const message =
      "postgres.external.host: expected a lowercase DNS hostname that the server certificate covers, such as " +
      "pg.corp.example; an IP address does not work, because Platform and Studio cannot verify one with sslmode=verify-full";
    for (const host of ["10.0.0.5", "fd00::5", "::ffff:10.0.0.5"]) {
      expect({ host, issues: issuesOf(external({ host, adminUser: "dba" })) }).toEqual({ host, issues: [message] });
    }
  });

  test("provisioning manual takes no admin credential, because a DBA runs the script of db-script", () => {
    expect(parseInstallation(external({ host: "pg.corp.example", provisioning: "manual" })).postgres).toEqual({
      mode: "external",
      external: { host: "pg.corp.example", port: 5432, provisioning: "manual" },
    });
    const message = "provisioning manual uses no admin credential, because a DBA runs the script of db-script";
    expect(
      issuesOf(
        external({
          host: "pg.corp.example",
          provisioning: "manual",
          adminUser: "dba",
          adminPasswordEnv: "PG",
        }),
      ),
    ).toEqual([`postgres.external.adminUser: ${message}`, `postgres.external.adminPasswordEnv: ${message}`]);
    expect(issuesOf(external({ host: "pg.corp.example", provisioning: "manual", adminPasswordFile: "/root/pg" }))).toEqual([
      `postgres.external.adminPasswordFile: ${message}`,
    ]);
  });

  test("refuses provisioning installer without the admin role, and both password references at once", () => {
    expect(issuesOf(external({ host: "pg.corp.example", adminPasswordEnv: "PG", adminPasswordFile: "/root/pg" }))).toEqual([
      "postgres.external.adminPasswordFile: set adminPasswordEnv or adminPasswordFile, not both",
      "postgres.external.adminUser: provisioning installer needs the admin role, a superuser or a role with CREATEROLE and CREATEDB",
    ]);
  });

  test("refuses an external mode without the server, a managed mode with one, and an invalid host or variable name", () => {
    expect(issuesOf(minimal({ postgres: { mode: "external" } }))).toEqual([
      "postgres.external: postgres.mode external needs the external server",
    ]);
    expect(issuesOf(minimal({ postgres: { mode: "managed", external: { host: "db.corp", adminUser: "dba" } } }))).toEqual([
      "postgres.external: only allowed when postgres.mode is external",
    ]);
    expect(issuesOf(external({ host: "PG.corp", adminUser: "dba", adminPasswordEnv: "1PG" }))).toEqual([
      "postgres.external.host: expected a lowercase DNS hostname that the server certificate covers, such as " +
        "pg.corp.example; an IP address does not work, because Platform and Studio cannot verify one with " +
        "sslmode=verify-full",
      "postgres.external.adminPasswordEnv: expected an environment variable name such as LIBREDB_PG_ADMIN_PASSWORD",
    ]);
    expect(issuesOf(external({ host: "db.corp", adminUser: "dba", sslmode: "require" }))).toEqual([
      'postgres.external: Unrecognized key: "sslmode"',
    ]);
  });
});

describe("keycloak accounts", () => {
  test("both accounts are on by default for a managed Keycloak and off for an external one, unless they are set", () => {
    const accounts = (keycloak: Record<string, unknown>) => {
      const { firstAdmin, userManager } = parseInstallation(minimal({ keycloak })).keycloak;
      return { firstAdmin, userManager };
    };
    expect(accounts({})).toEqual({
      firstAdmin: { enabled: true, username: "libredb-admin" },
      userManager: { enabled: true, username: "libredb-user-manager" },
    });
    expect(accounts(externalKeycloak())).toEqual({
      firstAdmin: { enabled: false, username: "libredb-admin" },
      userManager: { enabled: false, username: "libredb-user-manager" },
    });
    expect(
      accounts(externalKeycloak({ firstAdmin: { enabled: true }, userManager: { enabled: true, username: "idm" } })),
    ).toEqual({
      firstAdmin: { enabled: true, username: "libredb-admin" },
      userManager: { enabled: true, username: "idm" },
    });
    expect(accounts({ firstAdmin: { enabled: false }, userManager: { enabled: false } })).toEqual({
      firstAdmin: { enabled: false, username: "libredb-admin" },
      userManager: { enabled: false, username: "libredb-user-manager" },
    });
  });

  test("refuses one account as both the first admin and the user manager", () => {
    expect(issuesOf(minimal({ keycloak: { firstAdmin: { username: "ops" }, userManager: { username: "ops" } } }))).toEqual([
      "keycloak.userManager.username: the user manager must be another account than the first admin, and both are ops",
    ]);
  });

  test("refuses a username Keycloak would store differently", () => {
    expect(issuesOf(minimal({ keycloak: { firstAdmin: { username: "Admin" }, userManager: { username: "ab" } } }))).toEqual([
      "keycloak.firstAdmin.username: expected a lowercase Keycloak username of 3 to 255 characters: letters, digits, '.', '_', '@' or '-'",
      "keycloak.userManager.username: expected a lowercase Keycloak username of 3 to 255 characters: letters, digits, '.', '_', '@' or '-'",
    ]);
  });
});

describe("external keycloak", () => {
  test("keycloak.mode external needs keycloak.external, and a managed Keycloak refuses it", () => {
    expect(issuesOf(minimal({ keycloak: { mode: "external" } }))).toEqual([
      "keycloak.external: keycloak.mode external needs the base URL and the admin credential of the customer's Keycloak here",
    ]);
    const { mode: _mode, ...external } = externalKeycloak();
    expect(issuesOf(minimal({ keycloak: external }))).toEqual(["keycloak.external: applies only when keycloak.mode is external"]);
  });

  test("takes a client with its secret or a user of the admin realm with its password, each through one reference", () => {
    const parsed = (external: Record<string, unknown>) => {
      const { keycloak } = parseInstallation(minimal({ keycloak: externalKeycloak({}, external) }));
      if (keycloak.mode !== "external") throw new Error("not an external Keycloak");
      return keycloak.external;
    };
    expect(parsed({ adminRealm: "corp", adminPasswordEnv: undefined, adminPasswordFile: "/root/kc-admin" })).toEqual({
      baseUrl: "https://auth.corp",
      provisioning: "installer",
      adminRealm: "corp",
      adminUser: "admin",
      adminPasswordFile: "/root/kc-admin",
    });
    const neither = { adminUser: undefined, adminPasswordEnv: undefined };
    expect(issuesOf(minimal({ keycloak: externalKeycloak({}, neither) }))).toEqual([
      "keycloak.external: set either adminClientId with adminClientSecretEnv or adminClientSecretFile, or adminUser with " +
        "adminPasswordEnv or adminPasswordFile, for the account the installer configures the realm with",
    ]);
    expect(issuesOf(minimal({ keycloak: externalKeycloak({}, { adminClientId: "provisioner" }) }))).toHaveLength(1);
    expect(
      issuesOf(minimal({ keycloak: externalKeycloak({}, { adminPasswordFile: "/root/kc-admin", adminClientSecretEnv: "X" }) })),
    ).toEqual([
      "keycloak.external.adminClientSecretEnv: adminClientSecretEnv belongs to adminClientId, which is not set",
      "keycloak.external.adminUser: adminUser needs exactly one of adminPasswordEnv and adminPasswordFile",
    ]);
    expect(issuesOf(minimal({ keycloak: externalKeycloak({}, { adminPasswordEnv: "not a name" }) }))).toEqual([
      "keycloak.external.adminPasswordEnv: expected an environment variable name",
    ]);
  });

  test("provisioning manual takes the two app client secrets through one reference each and no admin credential", () => {
    const manual = { adminUser: undefined, adminPasswordEnv: undefined, provisioning: "manual" };
    const config = parseInstallation(
      minimal({
        keycloak: externalKeycloak({}, { ...manual, studioClientSecretEnv: "KC_STUDIO", platformClientSecretFile: "/root/kc-platform" }),
      }),
    );
    if (config.keycloak.mode !== "external") throw new Error("not an external Keycloak");
    expect(config.keycloak.external).toEqual({
      baseUrl: "https://auth.corp",
      provisioning: "manual",
      studioClientSecretEnv: "KC_STUDIO",
      platformClientSecretFile: "/root/kc-platform",
    });
    const noAdmin =
      "provisioning manual uses no Keycloak admin credential, because the site configures the realm from the export " +
      "of 'libredb-installer keycloak export'";
    expect(
      issuesOf(
        minimal({
          keycloak: externalKeycloak({}, {
            provisioning: "manual",
            adminRealm: "master",
            adminClientId: "provisioner",
            adminClientSecretFile: "/root/kc",
            studioClientSecretEnv: "KC_STUDIO",
            studioClientSecretFile: "/root/kc-studio",
          }),
        }),
      ),
    ).toEqual([
      `keycloak.external.adminRealm: ${noAdmin}`,
      `keycloak.external.adminClientId: ${noAdmin}`,
      `keycloak.external.adminClientSecretFile: ${noAdmin}`,
      `keycloak.external.adminUser: ${noAdmin}`,
      `keycloak.external.adminPasswordEnv: ${noAdmin}`,
      "keycloak.external.studioClientSecretEnv: provisioning manual needs exactly one of studioClientSecretEnv and studioClientSecretFile",
      "keycloak.external.platformClientSecretEnv: provisioning manual needs exactly one of platformClientSecretEnv and platformClientSecretFile",
    ]);
  });

  test("provisioning manual refuses an account the installer would create through the Admin API", () => {
    const manual = { adminUser: undefined, adminPasswordEnv: undefined, provisioning: "manual", studioClientSecretEnv: "S", platformClientSecretEnv: "P" };
    const message = "with keycloak.external.provisioning manual the site creates its users, so the installer creates no account";
    expect(
      issuesOf(minimal({ keycloak: externalKeycloak({ firstAdmin: { enabled: true }, userManager: { enabled: true } }, manual) })),
    ).toEqual([`keycloak.firstAdmin.enabled: ${message}`, `keycloak.userManager.enabled: ${message}`]);
    expect(parseInstallation(minimal({ keycloak: externalKeycloak({ firstAdmin: { enabled: false } }, manual) })).keycloak.firstAdmin).toEqual({
      enabled: false,
      username: "libredb-admin",
    });
  });

  test("provisioning installer generates the app client secrets, so it refuses their references", () => {
    expect(issuesOf(minimal({ keycloak: externalKeycloak({}, { platformClientSecretEnv: "KC_PLATFORM" }) }))).toEqual([
      "keycloak.external.platformClientSecretEnv: applies only with provisioning manual, because with provisioning " +
        "installer the installer generates the client secrets",
    ]);
    expect(issuesOf(minimal({ keycloak: externalKeycloak({}, { provisioning: "console" }) }))).toEqual([
      'keycloak.external.provisioning: Invalid option: expected one of "installer"|"manual"',
    ]);
  });

  test("refuses an inline app client secret, naming the references to use", () => {
    expect(issuesOf(minimal({ keycloak: externalKeycloak({}, { provisioning: "manual", studioClientSecret: "s" }) }))).toEqual([
      "keycloak.external.studioClientSecret: inline secrets are not allowed, use studioClientSecretEnv or studioClientSecretFile",
    ]);
  });

  test("refuses an inline admin password or client secret, naming the references to use", () => {
    expect(issuesOf(minimal({ keycloak: externalKeycloak({}, { adminPassword: "hunter2" }) }))).toEqual([
      "keycloak.external.adminPassword: inline secrets are not allowed, use adminPasswordEnv or adminPasswordFile",
    ]);
    expect(issuesOf(minimal({ keycloak: externalKeycloak({}, { adminClientSecret: "hunter2" }) }))).toEqual([
      "keycloak.external.adminClientSecret: inline secrets are not allowed, use adminClientSecretEnv or adminClientSecretFile",
    ]);
  });

  test("a base URL is https without credentials, query or fragment, kept without a trailing slash, on endpoints.hosts.auth", () => {
    const baseUrl = (url: string, auth = "auth.corp") => {
      const config = parseInstallation(
        minimal({
          endpoints: { hosts: { platform: "platform.corp", studio: "studio.corp", auth } },
          keycloak: externalKeycloak({}, { baseUrl: url, adminUrl: url }),
        }),
      );
      if (config.keycloak.mode !== "external") throw new Error("not an external Keycloak");
      return [config.keycloak.external.baseUrl, config.keycloak.external.adminUrl];
    };
    expect(baseUrl("https://AUTH.corp:443/auth/")).toEqual(["https://auth.corp/auth", "https://auth.corp/auth"]);
    expect(baseUrl("https://auth.corp:8443")).toEqual(["https://auth.corp:8443", "https://auth.corp:8443"]);
    expect(() => baseUrl("http://auth.corp")).toThrow("keycloak.external.baseUrl: expected an https:// URL");
    for (const url of ["https://admin:pw@auth.corp", "https://auth.corp/?realm=corp", "https://auth.corp/#x"]) {
      expect(() => baseUrl(url)).toThrow("keycloak.external.baseUrl: expected a URL without credentials, query or fragment");
    }
    expect(issuesOf(minimal({ keycloak: externalKeycloak({}, { baseUrl: "https://sso.corp" }) }))).toEqual([
      "keycloak.external.baseUrl: names the host sso.corp, and endpoints.hosts.auth is auth.corp; both name the " +
        "customer's Keycloak, so they must be equal",
    ]);
    expect(
      issuesOf(minimal({ mode: "kubernetes", keycloak: externalKeycloak({}, { baseUrl: "https://sso.corp" }) })),
    ).toHaveLength(1);
  });
});

describe("inline secrets", () => {
  test("names every inline secret with its JSON path, including keys inside lists", () => {
    expect(
      findInlineSecrets({
        password: "a",
        keycloak: { external: { clientSecret: "b", adminPasswordEnv: "KC_PASSWORD", adminPasswordFile: "/run/kc" } },
        backups: { passphrase: "c", targets: [{ accessKey: "d" }, { name: "e" }] },
        tls: { provided: { key: 42 } },
        unset: { adminPassword: null },
      }),
    ).toEqual([
      "password: inline secrets are not allowed, use passwordEnv or passwordFile",
      "keycloak.external.clientSecret: inline secrets are not allowed, use clientSecretEnv or clientSecretFile",
      "backups.passphrase: inline secrets are not allowed, use passphraseEnv or passphraseFile",
      "backups.targets[0].accessKey: inline secrets are not allowed, use accessKeyEnv or accessKeyFile",
      "tls.provided.key: inline secrets are not allowed, use keyEnv or keyFile",
    ]);
  });

  test("names every inline license token, which only the <key>File reference may carry", () => {
    expect(
      findInlineSecrets({
        platform: { license: "a", licenseFile: "/root/libredb.license" },
        future: { studioLicense: "b", licensePolicy: "c" },
      }),
    ).toEqual([
      "platform.license: inline license tokens are not allowed, use licenseFile",
      "future.studioLicense: inline license tokens are not allowed, use studioLicenseFile",
    ]);
  });

  test("leaves keys that only contain a secret word in the middle alone", () => {
    expect(findInlineSecrets({ keycloak: { realm: "libredb" }, passwordPolicy: "x", keyboard: "y", monkey: "z" })).toEqual([]);
  });

  test("runs before the schema, so it also guards keys the schema does not know yet", () => {
    expect(issuesOf(minimal({ future: { tokenSecret: "s3cr3t" } }))).toEqual([
      "future.tokenSecret: inline secrets are not allowed, use tokenSecretEnv or tokenSecretFile",
    ]);
  });
});

describe("tls modes", () => {
  const pair = (name: string) => ({ certificateFile: `/etc/corp/${name}.crt`, keyFile: `/etc/corp/${name}.key` });

  test("tls.mode provided takes a chain and key per endpoint and the CA bundle", () => {
    const installation = parseInstallation(
      minimal({
        tls: {
          mode: "provided",
          caBundleFile: "/etc/corp/ca.crt",
          provided: { platform: pair("platform"), studio: pair("studio"), auth: pair("auth") },
        },
      }),
    );
    expect(installation.tls.provided?.studio).toEqual(pair("studio"));
    expect(installation.tls.external).toBeUndefined();
  });

  test("tls.mode provided refuses a missing CA bundle, missing files and an auth pair missing for a managed Keycloak", () => {
    expect(issuesOf(minimal({ tls: { mode: "provided" } }))).toEqual([
      "tls.caBundleFile: tls.mode provided needs the CA bundle that the endpoint certificates validate against",
      "tls.provided: tls.mode provided needs a certificateFile and a keyFile for platform, studio and auth",
    ]);
    const withoutAuth = { mode: "provided", caBundleFile: "/c.crt", provided: { platform: pair("p"), studio: pair("s") } };
    expect(issuesOf(minimal({ tls: withoutAuth }))).toEqual([
      "tls.provided.auth: the edge serves the managed Keycloak, so it needs a certificateFile and a keyFile for auth",
    ]);
    expect(parseInstallation(minimal({ tls: withoutAuth, keycloak: { mode: "external", external: { baseUrl: "https://auth.corp", adminUser: "admin", adminPasswordEnv: "KC_ADMIN_PASSWORD" } } })).tls.provided?.auth).toBeUndefined();
    expect(issuesOf(minimal({ tls: { mode: "provided", caBundleFile: "/c.crt", provided: { platform: { certificateFile: "/p.crt" } } } }))).toEqual([
      "tls.provided.platform.keyFile: Invalid input: expected string, received undefined",
      "tls.provided.studio: Invalid input: expected object, received undefined",
    ]);
  });

  test("an inline key or certificate is refused, because provided keys come only through keyFile", () => {
    expect(issuesOf(minimal({ tls: { mode: "provided", provided: { platform: { key: "-----BEGIN PRIVATE KEY-----" } } } }))).toEqual([
      "tls.provided.platform.key: inline secrets are not allowed, use keyEnv or keyFile",
    ]);
  });

  test("tls.mode external defaults the plain HTTP port to 8080 and keeps the upstream proxies it names", () => {
    const installation = parseInstallation(
      minimal({ tls: { mode: "external", caBundleFile: "/etc/corp/ca.crt", external: { trustedProxies: ["192.0.2.10/32"] } } }),
    );
    expect(installation.tls.external).toEqual({ httpPort: 8080, trustedProxies: ["192.0.2.10/32"] });
    const set = parseInstallation(
      minimal({
        tls: {
          mode: "external",
          caBundleFile: "/etc/corp/ca.crt",
          external: { httpPort: 8081, trustedProxies: ["10.0.0.0/8", "fd00::/8"] },
        },
      }),
    );
    expect(set.tls.external).toEqual({ httpPort: 8081, trustedProxies: ["10.0.0.0/8", "fd00::/8"] });
  });

  test("tls.mode external refuses a configuration without tls.external.trustedProxies and takes private_ranges only written out", () => {
    const required =
      "tls.external.trustedProxies: must list the upstream proxy's addresses as CIDR ranges, such as 192.0.2.10/32, " +
      "because the edge trusts X-Forwarded-* headers only from them";
    expect(issuesOf(minimal({ tls: { mode: "external", caBundleFile: "/c.crt" } }))).toEqual([required]);
    expect(issuesOf(minimal({ tls: { mode: "external", caBundleFile: "/c.crt", external: { httpPort: 8081 } } }))).toEqual([
      required,
    ]);
    expect(issuesOf(minimal({ tls: { mode: "external", caBundleFile: "/c.crt", external: { trustedProxies: [] } } }))).toEqual([
      required,
    ]);
    const written = parseInstallation(
      minimal({ tls: { mode: "external", caBundleFile: "/c.crt", external: { trustedProxies: ["private_ranges"] } } }),
    );
    expect(written.tls.external).toEqual({ httpPort: 8080, trustedProxies: ["private_ranges"] });
  });

  test("tls.mode external refuses a missing CA bundle, a range that is not CIDR and keycloak.adminPort as HTTP port", () => {
    const proxy = ["192.0.2.10/32"];
    expect(issuesOf(minimal({ tls: { mode: "external", external: { trustedProxies: proxy } } }))).toEqual([
      "tls.caBundleFile: tls.mode external needs the CA bundle that the endpoint certificates validate against",
    ]);
    expect(
      issuesOf(minimal({ tls: { mode: "external", caBundleFile: "/c.crt", external: { trustedProxies: ["proxy.corp"] } } })),
    ).toEqual(["tls.external.trustedProxies[0]: expected a CIDR range such as 10.0.0.0/8 or fd00::/8, or private_ranges"]);
    expect(
      issuesOf(minimal({ tls: { mode: "external", caBundleFile: "/c.crt", external: { httpPort: 18080, trustedProxies: proxy } } })),
    ).toEqual(["tls.external.httpPort: 18080 is also keycloak.adminPort, so choose another port"]);
  });

  test("the provided and external sections are refused in another mode", () => {
    expect(
      issuesOf(minimal({ tls: { mode: "generated", provided: { platform: pair("p"), studio: pair("s") }, external: {} } })),
    ).toEqual(["tls.provided: is read only in tls.mode provided", "tls.external: is read only in tls.mode external"]);
  });
});

describe("mobile app", () => {
  const REDIRECT = "org.libredb.mobile:/oauth2redirect";

  test("is absent unless set, and takes the app's redirect URI for both URIs by default", () => {
    expect("mobile" in parseInstallation(minimal())).toBe(false);
    expect(parseInstallation(minimal({ mobile: { enabled: true } })).mobile).toEqual({
      enabled: true,
      redirectUri: REDIRECT,
      postLogoutRedirectUri: REDIRECT,
    });
    expect(parseInstallation(minimal({ mobile: { enabled: false } })).mobile).toEqual({
      enabled: false,
      redirectUri: REDIRECT,
      postLogoutRedirectUri: REDIRECT,
    });
  });

  test("keeps a private-use scheme in reverse domain name form or an https URL that the configuration sets", () => {
    const mobile = parseInstallation(
      minimal({
        mobile: {
          enabled: true,
          redirectUri: "com.corp.libredb:/oauth2redirect",
          postLogoutRedirectUri: "https://app.corp.example/signed-out",
        },
      }),
    ).mobile;
    expect(mobile).toEqual({
      enabled: true,
      redirectUri: "com.corp.libredb:/oauth2redirect",
      postLogoutRedirectUri: "https://app.corp.example/signed-out",
    });
  });

  test("needs enabled, refuses unknown keys, and refuses a URI an attacker's app or page could claim", () => {
    expect(issuesOf(minimal({ mobile: {} }))).toEqual(["mobile.enabled: Invalid input: expected boolean, received undefined"]);
    expect(issuesOf(minimal({ mobile: { enabled: true, clientId: "app" } }))).toEqual([
      'mobile: Unrecognized key: "clientId"',
    ]);
    const expected =
      "expected a private-use URI scheme in reverse domain name form, such as org.libredb.mobile:/oauth2redirect, or " +
      "an https:// URL, without a wildcard or a fragment";
    for (const uri of ["libredb:/oauth2redirect", "http://app.corp.example/cb", "org.libredb.mobile:/*", "https://app.corp.example/cb#x", "not a uri"]) {
      expect(issuesOf(minimal({ mobile: { enabled: true, redirectUri: uri } }))).toEqual([`mobile.redirectUri: ${expected}`]);
    }
  });
});
