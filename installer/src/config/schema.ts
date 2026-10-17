// LibreDBInstallation v1: the declarative configuration the installer reads.
import { isIP } from "node:net";
import { z } from "zod";

export const API_VERSION = "install.libredb.org/v1";
export const KIND = "LibreDBInstallation";

/** A configuration that cannot be used, with one line per problem, each prefixed by its JSON path. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("\n"));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out === "" ? "(root)" : out;
}

// A key that holds a customer secret: `password`, `adminPassword`, `clientSecret`, `passphrase`, `accessKey`.
// Such a value is accepted only through the `<key>Env` or `<key>File` reference keys.
const SECRET_KEY = /^(?:password|secret|passphrase|key)$|(?:Password|Secret|Passphrase|Key)$/;

// A key that holds a license token, such as `license`. The token is accepted only through the `<key>File` reference
// key, so that neither the printed configuration nor the applied one that the installer keeps on the host holds it.
const LICENSE_KEY = /^license$|License$/;

/**
 * The shape of a license token: `ldl1`, a kid of 16 lowercase hex digits, then the payload and the signature in unpadded
 * base64url, joined by dots. The installer checks only this shape, because Platform verifies the token when it starts.
 */
export const LICENSE_TOKEN = /^ldl1\.[0-9a-f]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Why an inline value under this key is refused, or undefined when the key may hold it.
function inlineIssue(key: string, value: unknown): string | undefined {
  if (value === null || typeof value === "object") return undefined;
  if (SECRET_KEY.test(key)) return `inline secrets are not allowed, use ${key}Env or ${key}File`;
  if (LICENSE_KEY.test(key)) return `inline license tokens are not allowed, use ${key}File`;
  return undefined;
}

/**
 * Returns one issue per inline secret or license token in a raw configuration document.
 * It walks the raw document before the schema, so it also guards keys the schema does not define yet.
 */
export function findInlineSecrets(raw: unknown): string[] {
  const issues: string[] = [];
  const walk = (value: unknown, path: PropertyKey[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, index]));
    } else if (isMapping(value)) {
      for (const [key, child] of Object.entries(value)) {
        const issue = inlineIssue(key, child);
        if (issue === undefined) walk(child, [...path, key]);
        else issues.push(`${formatPath([...path, key])}: ${issue}`);
      }
    }
  };
  walk(raw, []);
  return issues;
}

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const hostname = z
  .string()
  .max(253)
  .refine((value) => value.split(".").every((label) => dnsLabel.test(label)), {
    message: "expected a lowercase DNS hostname such as studio.example.com",
  });

const port = z.number().int().min(1).max(65535);

const filePath = z.string().min(1);

const endpointHosts = z
  .object({
    style: z.literal("hostnames"),
    hosts: z
      .object({
        platform: hostname,
        studio: hostname,
        auth: hostname,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Map<string, string>();
    for (const [endpoint, host] of Object.entries(value.hosts)) {
      const first = seen.get(host);
      if (first === undefined) {
        seen.set(host, endpoint);
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["hosts", endpoint],
          message: `the hostnames style needs a distinct host per endpoint, and ${host} is also used by ${first}`,
        });
      }
    }
  });

/** The TLS ports of the ports style when the configuration sets none. */
export const DEFAULT_ENDPOINT_PORTS = { platform: 443, studio: 8443, auth: 9443 } as const;

// One host with a distinct TLS port per endpoint, for a site without DNS. It shares cookies and HSTS across the apps,
// because browsers scope them by host and not by port, so it is a downgrade from separate hostnames that
// installer/README.md documents.
const endpointPorts = z
  .object({
    style: z.literal("ports"),
    host: hostname,
    ports: z
      .object({
        platform: port.default(DEFAULT_ENDPOINT_PORTS.platform),
        studio: port.default(DEFAULT_ENDPOINT_PORTS.studio),
        auth: port.default(DEFAULT_ENDPOINT_PORTS.auth),
      })
      .strict()
      .default(DEFAULT_ENDPOINT_PORTS),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Map<number, string>();
    for (const [endpoint, number] of Object.entries(value.ports)) {
      const first = seen.get(number);
      if (first === undefined) {
        seen.set(number, endpoint);
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["ports", endpoint],
          message: `the ports style needs a distinct port per endpoint, and ${number} is also used by ${first}`,
        });
      }
    }
  });

// An absent style means hostnames, the default; the ports style is only for a site where DNS is impossible.
const endpoints = z.preprocess(
  (value) => (isMapping(value) && value.style === undefined ? { ...value, style: "hostnames" } : value),
  z.discriminatedUnion("style", [endpointHosts, endpointPorts], {
    error: (issue) =>
      issue.code === "invalid_union" ? 'Invalid option: expected one of "hostnames"|"ports"' : undefined,
  }),
);

// The chain (leaf first, then the intermediates) and the unencrypted private key of one public endpoint.
const providedFiles = z
  .object({
    certificateFile: filePath,
    keyFile: filePath,
  })
  .strict();

// An IPv4 or IPv6 range in CIDR notation, such as 10.0.0.0/8, or Caddy's private_ranges shorthand.
const proxyRange = z
  .string()
  .regex(
    /^(?:private_ranges|(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}|[0-9a-fA-F:]*:[0-9a-fA-F:.]*\/\d{1,3})$/,
    "expected a CIDR range such as 10.0.0.0/8 or fd00::/8, or private_ranges",
  );

/** The edge's plain HTTP port in `tls.mode: external` when the configuration sets none. */
export const DEFAULT_EXTERNAL_HTTP_PORT = 8080;

// The edge passes X-Forwarded-* on only from the upstream proxy, so tls.mode external has no default for its
// addresses: one as wide as private_ranges would let any client on a private network that reaches the edge's port
// directly set X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host.
const TRUSTED_PROXIES_REQUIRED =
  "must list the upstream proxy's addresses as CIDR ranges, such as 192.0.2.10/32, because the edge trusts " +
  "X-Forwarded-* headers only from them";

const externalTls = z
  .object({
    httpPort: port.default(DEFAULT_EXTERNAL_HTTP_PORT),
    // Required in tls.mode external, the one mode that reads this section, which the refinement of tls checks.
    trustedProxies: z.array(proxyRange).min(1, TRUSTED_PROXIES_REQUIRED).optional(),
  })
  .strict();

const tls = z
  .object({
    mode: z.enum(["generated", "provided", "external"]).default("generated"),
    caBundleFile: filePath.optional(),
    // tls.mode provided: the customer's chain and key per endpoint. The auth entry is needed only while
    // the edge serves the managed Keycloak.
    provided: z
      .object({
        platform: providedFiles,
        studio: providedFiles,
        auth: providedFiles.optional(),
      })
      .strict()
      .optional(),
    // tls.mode external: the upstream proxy terminates TLS and the edge serves plain HTTP on httpPort.
    external: externalTls.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== "generated" && value.caBundleFile === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["caBundleFile"],
        message: `tls.mode ${value.mode} needs the CA bundle that the endpoint certificates validate against`,
      });
    }
    if (value.mode === "provided" && value.provided === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["provided"],
        message: "tls.mode provided needs a certificateFile and a keyFile for platform, studio and auth",
      });
    }
    if (value.mode !== "provided" && value.provided !== undefined) {
      ctx.addIssue({ code: "custom", path: ["provided"], message: "is read only in tls.mode provided" });
    }
    if (value.mode === "external" && value.external?.trustedProxies === undefined) {
      ctx.addIssue({ code: "custom", path: ["external", "trustedProxies"], message: TRUSTED_PROXIES_REQUIRED });
    }
    if (value.mode !== "external" && value.external !== undefined) {
      ctx.addIssue({ code: "custom", path: ["external"], message: "is read only in tls.mode external" });
    }
  })
  // After the refinement an external section exists only in tls.mode external, and always with its trustedProxies.
  .transform(({ external, ...value }): typeof value & { external?: { httpPort: number; trustedProxies: string[] } } =>
    external?.trustedProxies === undefined
      ? value
      : { ...value, external: { httpPort: external.httpPort, trustedProxies: external.trustedProxies } },
  );

const componentMode = z.enum(["managed", "external"]).default("managed");

// The DNS hostname of a PostgreSQL server outside the installation, which its certificate covers. An IP address does
// not work: the PostgreSQL client of Platform and Studio verifies a certificate against localhost instead of an IP
// address, so sslmode=verify-full would fail there.
const serverHost = z
  .string()
  .max(253)
  .refine((value) => isIP(value) === 0 && value.split(".").every((label) => dnsLabel.test(label)), {
    message:
      "expected a lowercase DNS hostname that the server certificate covers, such as pg.corp.example; an IP address " +
      "does not work, because Platform and Studio cannot verify one with sslmode=verify-full",
  });

const postgresEnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected an environment variable name such as LIBREDB_PG_ADMIN_PASSWORD");

/**
 * An external PostgreSQL server. With provisioning installer, apply provisions it as the admin role,
 * whose password the installer reads on each run that needs it and never persists; with provisioning manual, a DBA
 * runs the script that db-script writes, and the installer holds no admin credential at all.
 */
const externalPostgres = z
  .object({
    host: serverHost,
    port: port.default(5432),
    adminUser: z.string().min(1).max(63).optional(),
    adminPasswordEnv: postgresEnvName.optional(),
    adminPasswordFile: filePath.optional(),
    caBundleFile: filePath.optional(),
    provisioning: z.enum(["installer", "manual"]).default("installer"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.adminPasswordEnv !== undefined && value.adminPasswordFile !== undefined) {
      ctx.addIssue({ code: "custom", path: ["adminPasswordFile"], message: "set adminPasswordEnv or adminPasswordFile, not both" });
    }
    if (value.provisioning === "installer" && value.adminUser === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["adminUser"],
        message: "provisioning installer needs the admin role, a superuser or a role with CREATEROLE and CREATEDB",
      });
    }
    if (value.provisioning === "manual") {
      for (const key of ["adminUser", "adminPasswordEnv", "adminPasswordFile"] as const) {
        if (value[key] === undefined) continue;
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "provisioning manual uses no admin credential, because a DBA runs the script of db-script",
        });
      }
    }
  });

export type ExternalPostgres = z.output<typeof externalPostgres>;

const postgres = z
  .object({
    mode: componentMode,
    external: externalPostgres.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "external" && value.external === undefined) {
      ctx.addIssue({ code: "custom", path: ["external"], message: "postgres.mode external needs the external server" });
    }
    if (value.mode === "managed" && value.external !== undefined) {
      ctx.addIssue({ code: "custom", path: ["external"], message: "only allowed when postgres.mode is external" });
    }
  })
  // Narrows the type, so `external` is defined exactly when the mode is external.
  .transform((value) =>
    value.mode === "external"
      ? { mode: "external" as const, external: value.external as ExternalPostgres }
      : { mode: "managed" as const },
  );

// Keycloak stores usernames in lowercase, so a configured username must already be in the form Keycloak keeps.
const keycloakUsername = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._@-]{2,254}$/,
    "expected a lowercase Keycloak username of 3 to 255 characters: letters, digits, '.', '_', '@' or '-'",
  );

const realmName = z.string().regex(/^[A-Za-z0-9_-]+$/, "expected letters, digits, '_' or '-'");

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected an environment variable name");

// The URL of a Keycloak: https, a host, an optional port and an optional path such as /auth, and no credentials, query
// or fragment. It is kept as the URL parser writes it without a trailing slash, so the issuer is `<url>/realms/<realm>`.
const keycloakUrl = z
  .url({ protocol: /^https$/, error: "expected an https:// URL such as https://sso.example.com" })
  .refine((value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  }, "expected a URL without credentials, query or fragment")
  .transform((value) => {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  });

// The two ways the installer signs in to an external Keycloak's Admin API, each with its secret's references.
const ADMIN_CREDENTIALS = [
  { key: "adminClientId", references: ["adminClientSecretEnv", "adminClientSecretFile"] },
  { key: "adminUser", references: ["adminPasswordEnv", "adminPasswordFile"] },
] as const;

// The secrets of the two app clients when the site configures the realm itself, each through one reference.
const APP_CLIENT_SECRETS = [
  { key: "studioClientSecret", references: ["studioClientSecretEnv", "studioClientSecretFile"] },
  { key: "platformClientSecret", references: ["platformClientSecretEnv", "platformClientSecretFile"] },
] as const;

const ADMIN_KEYS = [
  "adminRealm",
  ...ADMIN_CREDENTIALS.flatMap((credential) => [credential.key, ...credential.references]),
] as const;

type ExternalKeycloakFields = { provisioning: "installer" | "manual" } & Partial<
  Record<(typeof ADMIN_KEYS)[number] | (typeof APP_CLIENT_SECRETS)[number]["references"][number], string>
>;

// provisioning installer: the admin credential is either a confidential client with its secret or a user of
// `adminRealm` with its password, which signs in through admin-cli, and the app client secrets are the installer's.
function refineAdminCredential(value: ExternalKeycloakFields, ctx: z.RefinementCtx): void {
  const chosen = ADMIN_CREDENTIALS.filter((credential) => value[credential.key] !== undefined);
  const [credential] = chosen;
  if (credential === undefined || chosen.length > 1) {
    ctx.addIssue({
      code: "custom",
      path: [],
      message:
        "set either adminClientId with adminClientSecretEnv or adminClientSecretFile, or adminUser with " +
        "adminPasswordEnv or adminPasswordFile, for the account the installer configures the realm with",
    });
    return;
  }
  for (const candidate of ADMIN_CREDENTIALS) {
    const references = candidate.references.filter((reference) => value[reference] !== undefined);
    if (candidate === credential && references.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: [candidate.key],
        message: `${candidate.key} needs exactly one of ${candidate.references.join(" and ")}`,
      });
    }
    if (candidate !== credential) {
      for (const reference of references) {
        ctx.addIssue({ code: "custom", path: [reference], message: `${reference} belongs to ${candidate.key}, which is not set` });
      }
    }
  }
}

// provisioning manual: the site configures the realm from the installer's export and shares only the secrets of
// libredb-studio and libredb-platform, so the installer takes no admin credential.
function refineAppClientSecrets(value: ExternalKeycloakFields, ctx: z.RefinementCtx): void {
  for (const key of ADMIN_KEYS) {
    if (value[key] === undefined) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message:
        "provisioning manual uses no Keycloak admin credential, because the site configures the realm from the " +
        "export of 'libredb-installer keycloak export'",
    });
  }
  for (const secret of APP_CLIENT_SECRETS) {
    if (secret.references.filter((reference) => value[reference] !== undefined).length === 1) continue;
    ctx.addIssue({
      code: "custom",
      path: [secret.references[0]],
      message: `provisioning manual needs exactly one of ${secret.references.join(" and ")}`,
    });
  }
}

// The customer's Keycloak whose realm the installer reuses. With provisioning installer the
// installer configures the realm through the Admin API with the customer's admin credential, which it reads on each
// run that needs it and never stores; with provisioning manual the site configures it and the installer checks it.
const keycloakExternal = z
  .object({
    baseUrl: keycloakUrl,
    // Where Platform and the installer reach the Admin API when the site serves it apart from the public URL.
    adminUrl: keycloakUrl.optional(),
    provisioning: z.enum(["installer", "manual"]).default("installer"),
    adminRealm: realmName.optional(),
    adminClientId: z.string().min(1).optional(),
    adminClientSecretEnv: envName.optional(),
    adminClientSecretFile: filePath.optional(),
    adminUser: z.string().min(1).optional(),
    adminPasswordEnv: envName.optional(),
    adminPasswordFile: filePath.optional(),
    studioClientSecretEnv: envName.optional(),
    studioClientSecretFile: filePath.optional(),
    platformClientSecretEnv: envName.optional(),
    platformClientSecretFile: filePath.optional(),
    // The CA of a private issuer, which the CA bundle adds for both apps and the installer trusts besides the system roots.
    caBundleFile: filePath.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provisioning === "manual") {
      refineAppClientSecrets(value, ctx);
      return;
    }
    refineAdminCredential(value, ctx);
    for (const reference of APP_CLIENT_SECRETS.flatMap((secret) => secret.references)) {
      if (value[reference] === undefined) continue;
      ctx.addIssue({
        code: "custom",
        path: [reference],
        message: "applies only with provisioning manual, because with provisioning installer the installer generates the client secrets",
      });
    }
  })
  // The admin realm of provisioning installer is master unless set.
  .transform((value) =>
    value.provisioning === "installer" ? { ...value, adminRealm: value.adminRealm ?? "master" } : value,
  );

const keycloak = z
  .object({
    mode: componentMode,
    realm: realmName.default("libredb"),
    adminPort: port.default(18080),
    // The first LibreDB admin, and the Keycloak account that administers users: two accounts, so that the first admin
    // holds no Keycloak role that could give libredb:admin to anyone. An absent `enabled` means on for a managed
    // Keycloak and off for an external one, whose users the customer's identity team manages.
    firstAdmin: z
      .object({
        enabled: z.boolean().optional(),
        username: keycloakUsername.default("libredb-admin"),
      })
      .strict()
      .default({ username: "libredb-admin" }),
    userManager: z
      .object({
        enabled: z.boolean().optional(),
        username: keycloakUsername.default("libredb-user-manager"),
      })
      .strict()
      .default({ username: "libredb-user-manager" }),
    external: keycloakExternal.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.userManager.username === value.firstAdmin.username) {
      ctx.addIssue({
        code: "custom",
        path: ["userManager", "username"],
        message:
          "the user manager must be another account than the first admin, " +
          `and both are ${value.firstAdmin.username}`,
      });
    }
    // The installer creates an account through the Admin API, which provisioning manual gives it no access to.
    if (value.external?.provisioning === "manual") {
      for (const account of ["firstAdmin", "userManager"] as const) {
        if (value[account].enabled !== true) continue;
        ctx.addIssue({
          code: "custom",
          path: [account, "enabled"],
          message: "with keycloak.external.provisioning manual the site creates its users, so the installer creates no account",
        });
      }
    }
  })
  .transform(({ mode, realm, adminPort, firstAdmin, userManager, external }, ctx) => {
    const managed = mode === "managed";
    const common = {
      realm,
      adminPort,
      firstAdmin: { enabled: firstAdmin.enabled ?? managed, username: firstAdmin.username },
      userManager: { enabled: userManager.enabled ?? managed, username: userManager.username },
    };
    if (mode === "external" && external !== undefined) return { mode, ...common, external };
    if (mode === "managed" && external === undefined) return { mode, ...common };
    ctx.issues.push({
      code: "custom",
      input: external,
      path: ["external"],
      message: managed
        ? "applies only when keycloak.mode is external"
        : "keycloak.mode external needs the base URL and the admin credential of the customer's Keycloak here",
    });
    return z.NEVER;
  });

// The file that holds the license token. A value of the token's own shape is refused without being repeated, because
// validate prints the configuration and apply names a missing file, either of which would print the token.
const licenseFile = filePath.refine((value) => !LICENSE_TOKEN.test(value), {
  message: "expected the path of the file that holds the license token, not the token itself",
});

const platform = z
  .object({
    organizationName: z.string().min(1),
    // Platform's bounds for QUERY_LOG_RETENTION_DAYS; absent means the default of 90 days.
    queryLogRetentionDays: z.number().int().min(1).max(36500).optional(),
    // The previous AUTH_SECRET during a rotation, written as AUTH_SECRET_PREVIOUS for one session lifetime.
    authSecretPreviousFile: filePath.optional(),
    // Written as PLATFORM_LICENSE; without it Platform runs on its free tier.
    licenseFile: licenseFile.optional(),
  })
  .strict();

// A seal key id: the lowercase hex of the first 8 bytes of SHA-256 of the raw public key.
const sealKid = z.string().regex(/^[0-9a-f]{16}$/, "expected a seal key id of 16 lowercase hex digits");

// The seal key rotation: issueNew adds one live key to Studio's keyring, activeKid selects the key whose public half
// Platform receives (the oldest live key when absent), and retire removes kids from the live keyring while the secret
// store keeps them in escrow.
const bridge = z
  .object({
    sealKeys: z
      .object({
        issueNew: z.boolean().default(false),
        activeKid: sealKid.optional(),
        retire: z
          .array(sealKid)
          .default([])
          .refine((kids) => new Set(kids).size === kids.length, "expected distinct kids"),
      })
      .strict()
      .default({ issueNew: false, retire: [] }),
  })
  .strict();

const images = z
  .object({
    registry: z
      .string()
      .regex(
        /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/,
        "expected a registry host with an optional port and path, such as harbor.corp/libredb, without a scheme",
      ),
  })
  .strict();

const network = z
  .object({
    httpsProxy: z.url({ protocol: /^https?$/, error: "expected an http:// or https:// proxy URL" }),
  })
  .strict();

const backups = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict();

const docker = z
  .object({
    systemdUnit: z.boolean().default(false),
  })
  .strict();

const kubernetes = z
  .object({
    namespace: z.string().regex(dnsLabel, "expected a Kubernetes namespace name").default("libredb"),
    createNamespace: z.boolean().default(false),
    exposure: z.enum(["ingress", "edgeLoadBalancer"]).default("ingress"),
  })
  .strict();

// The shared fields, in the order the normalized configuration prints them.
const head = {
  apiVersion: z.literal(API_VERSION),
  kind: z.literal(KIND),
  metadata: z
    .object({
      name: z.string().regex(dnsLabel, "expected a lowercase DNS label such as acme"),
    })
    .strict(),
};

const tail = {
  endpoints,
  tls: tls.default({ mode: "generated" }),
  postgres: postgres.default({ mode: "managed" }),
  keycloak: keycloak.default({
    mode: "managed",
    realm: "libredb",
    adminPort: 18080,
    firstAdmin: { enabled: true, username: "libredb-admin" },
    userManager: { enabled: true, username: "libredb-user-manager" },
  }),
  platform,
  images: images.optional(),
  network: network.optional(),
  backups: backups.default({ enabled: true }),
  bridge: bridge.default({ sealKeys: { issueNew: false, retire: [] } }),
};

type InstallationFields = {
  endpoints: z.output<typeof endpoints>;
  tls: z.output<typeof tls>;
  keycloak: z.output<typeof keycloak>;
};

// The checks that span sections: the provided auth certificate exists while the edge serves the managed Keycloak,
// the external HTTP port is not Keycloak's loopback admin port, and the auth endpoint of an install against an
// external Keycloak is that Keycloak, so NO_PROXY, the report and every check that names the auth host agree with
// the issuer.
function refineInstallation(value: InstallationFields, ctx: z.RefinementCtx): void {
  const { provided } = value.tls;
  if (value.tls.mode === "provided" && provided !== undefined && provided.auth === undefined && value.keycloak.mode === "managed") {
    ctx.addIssue({
      code: "custom",
      path: ["tls", "provided", "auth"],
      message: "the edge serves the managed Keycloak, so it needs a certificateFile and a keyFile for auth",
    });
  }
  if (value.tls.external !== undefined && value.tls.external.httpPort === value.keycloak.adminPort) {
    ctx.addIssue({
      code: "custom",
      path: ["tls", "external", "httpPort"],
      message: `${value.tls.external.httpPort} is also keycloak.adminPort, so choose another port`,
    });
  }
  // The ports style refuses an external Keycloak on its own, and has no auth host to compare.
  if (value.keycloak.mode !== "external" || value.endpoints.style !== "hostnames") return;
  const host = new URL(value.keycloak.external.baseUrl).hostname;
  const auth = value.endpoints.hosts.auth;
  if (host !== auth) {
    ctx.addIssue({
      code: "custom",
      path: ["keycloak", "external", "baseUrl"],
      message: `names the host ${host}, and endpoints.hosts.auth is ${auth}; both name the customer's Keycloak, so they must be equal`,
    });
  }
}

const dockerInstallation = z
  .object({
    ...head,
    mode: z.literal("docker"),
    ...tail,
    docker: docker.default({ systemdUnit: false }),
  })
  .strict()
  .superRefine((value, ctx) => {
    refineInstallation(value, ctx);
    if (value.endpoints.style !== "ports") return;
    // An external Keycloak serves its own host, which the one host of the ports style cannot name.
    if (value.keycloak.mode !== "managed") {
      ctx.addIssue({
        code: "custom",
        path: ["endpoints", "style"],
        message: "the ports style serves Keycloak on the one host, so it needs keycloak.mode managed",
      });
    }
    // The ports style serves every endpoint on one host with one leaf, while tls.mode provided takes a chain per
    // endpoint and tls.mode external tells the sites apart by hostname on one plain HTTP port.
    if (value.tls.mode !== "generated") {
      ctx.addIssue({
        code: "custom",
        path: ["tls", "mode"],
        message: `the ports style serves every endpoint on one host with one generated leaf, so it needs tls.mode generated, not ${value.tls.mode}`,
      });
    }
  });

const kubernetesInstallation = z
  .object({
    ...head,
    mode: z.literal("kubernetes"),
    ...tail,
    kubernetes: kubernetes.default({ namespace: "libredb", createNamespace: false, exposure: "ingress" }),
  })
  .strict()
  .superRefine((value, ctx) => {
    refineInstallation(value, ctx);
    if (value.endpoints.style === "ports") {
      ctx.addIssue({
        code: "custom",
        path: ["endpoints", "style"],
        message: "the ports style is allowed only in docker mode, use the hostnames style",
      });
    }
  });

export const libreDBInstallation = z.discriminatedUnion("mode", [dockerInstallation, kubernetesInstallation], {
  error: (issue) =>
    issue.code === "invalid_union" ? 'Invalid option: expected one of "docker"|"kubernetes"' : undefined,
});

export type LibreDBInstallation = z.output<typeof libreDBInstallation>;
export type DockerInstallation = z.output<typeof dockerInstallation>;
export type KubernetesInstallation = z.output<typeof kubernetesInstallation>;

/** `keycloak.external` of an install that reuses a realm of the customer's Keycloak. */
export type ExternalKeycloak = z.output<typeof keycloakExternal>;

/** Validates a raw document: the inline-secret rule first, then the schema. Throws ConfigError. */
export function parseInstallation(raw: unknown): LibreDBInstallation {
  const secrets = findInlineSecrets(raw);
  if (secrets.length > 0) throw new ConfigError(secrets);
  const result = libreDBInstallation.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`));
  }
  return result.data;
}
