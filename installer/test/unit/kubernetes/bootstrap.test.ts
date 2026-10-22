import { describe, expect, test } from "bun:test";
import { PLATFORM_ENV_KEYS, PLATFORM_MIGRATE_ENV_KEYS } from "../../../src/contracts/platform";
import { APP_SECRET_NAMES, POSTGRES_SUPERUSER_SECRET } from "../../../src/docker/secrets";
import { CLIENT_SECRET_NAMES } from "../../../src/keycloak/desired";
import {
  addPendingRestarts,
  caBundleOf,
  checkRelease,
  pendingRestartsOf,
  runRestarts,
  RELEASE_KEY,
  sameData,
  checkInstallation,
  convergeStore,
  convergeTls,
  generatedNames,
  keycloakEdgeCaddyfile,
  loadState,
  observedTls,
  runBootstrap,
  saveState,
  rotateSealKeys,
  SEAL_ENVELOPES_FILE,
  sealKeysOf,
  STATE_KEY,
} from "../../../src/kubernetes/bootstrap";
import { INPUT_DIR, K8S_NAMES, STORE_KEYS, STUDIO_SECRET_KEYS, WORKLOADS } from "../../../src/kubernetes/names";
import { Redactor } from "../../../src/log/redact";
import { emptyState } from "../../../src/state/store";
import { UnsafeChangeError } from "../../../src/state/immutable";
import { createCa } from "../../../src/tls/ca";
import { manifestFixture } from "../release/fixture";
import { EXTERNAL_POSTGRES, files, installation, INSTALLER_KEYCLOAK, io, LICENSE, MANUAL_KEYCLOAK, MemoryObjects } from "./fixture";

const STUDIO_SECRET = "libredb-studio-env";

async function bootstrap(objects: MemoryObjects, config = installation(), readFile = files(), now?: Date) {
  const run = io(objects, readFile, now);
  await runBootstrap({ config, manifest: manifestFixture(), studioSecretName: STUDIO_SECRET }, run.io);
  return run.lines;
}

describe("the bootstrap job with a managed PostgreSQL and Keycloak", () => {
  test("writes every Secret and ConfigMap the chart's workloads mount", async () => {
    const objects = new MemoryObjects();
    const lines = await bootstrap(objects);
    expect([...objects.secrets.keys()].sort()).toEqual(
      [
        K8S_NAMES.secretStore,
        K8S_NAMES.state,
        K8S_NAMES.tls,
        K8S_NAMES.platformEnv,
        K8S_NAMES.migrateEnv,
        STUDIO_SECRET,
        K8S_NAMES.studioNetworkEnv,
        K8S_NAMES.postgresSuperuser,
        K8S_NAMES.postgresTls,
        K8S_NAMES.postgresProvision,
        K8S_NAMES.keycloakEnv,
        K8S_NAMES.keycloakConfig,
        K8S_NAMES.ingressTls("platform"),
        K8S_NAMES.ingressTls("studio"),
        K8S_NAMES.ingressTls("auth"),
      ].sort(),
    );
    expect([...objects.configMaps.keys()].sort()).toEqual(
      [K8S_NAMES.caBundle, K8S_NAMES.postgresConfig, K8S_NAMES.keycloakEdge].sort(),
    );
    expect(objects.secrets.get(K8S_NAMES.ingressTls("platform"))?.type).toBe("kubernetes.io/tls");
    expect(lines.at(-1)).toBe("bootstrap done");
    expect(lines.join("\n")).not.toContain(objects.secret(K8S_NAMES.secretStore)[APP_SECRET_NAMES.platformAuthSecret] as string);
  });

  test("Platform's environment holds exactly the installer's env set, never MIGRATE_DATABASE_URL", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    const env = objects.secret(K8S_NAMES.platformEnv);
    for (const key of Object.keys(env)) expect(PLATFORM_ENV_KEYS as readonly string[]).toContain(key);
    expect(env.MIGRATE_DATABASE_URL).toBeUndefined();
    expect(env.PLATFORM_LICENSE).toBe(LICENSE);
    expect(env.AUTH_URL).toBe("https://platform.libredb.test");
    expect(env.AUTH_KEYCLOAK_ISSUER).toBe("https://auth.libredb.test/realms/libredb");
    expect(env.KEYCLOAK_ADMIN_URL).toBe("http://keycloak:8080");
    expect(env.DATABASE_URL).toStartWith("postgresql://libredb_platform:");
    expect(env.DATABASE_URL).toContain("@libredb-postgres:5432/libredb?schema=platform&sslmode=verify-full");
    const migrate = objects.secret(K8S_NAMES.migrateEnv);
    for (const key of Object.keys(migrate)) expect(PLATFORM_MIGRATE_ENV_KEYS as readonly string[]).toContain(key);
    expect(migrate.MIGRATE_DATABASE_URL).toStartWith("postgresql://libredb_owner:");
  });

  test("Studio's Secret holds the keys of the Studio chart, a keyring of the live seal key and the studio role's URL", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    const studio = objects.secret(STUDIO_SECRET);
    expect(Object.keys(studio).sort()).toEqual(Object.values(STUDIO_SECRET_KEYS).sort());
    expect(studio[STUDIO_SECRET_KEYS.oidcClientId]).toBe("libredb-studio");
    expect(studio[STUDIO_SECRET_KEYS.governancePostgresUrl]).toStartWith("postgresql://libredb_studio:");
    const keyring = JSON.parse(studio[STUDIO_SECRET_KEYS.governancePrivateKeys] as string) as { version: number; keys: string[] };
    const seal = JSON.parse(objects.secret(K8S_NAMES.secretStore)[STORE_KEYS.sealKeys] as string) as { privateKey: string; publicKey: string }[];
    expect(keyring).toEqual({ version: 1, keys: [seal[0]?.privateKey as string] });
    // Platform holds the public half only.
    expect(objects.secret(K8S_NAMES.platformEnv).BRIDGE_SEAL_PUBLIC_KEY).toBe(seal[0]?.publicKey as string);
    expect(JSON.stringify(objects.secret(K8S_NAMES.platformEnv))).not.toContain(seal[0]?.privateKey as string);
  });

  test("the managed server gets the installer's pg_hba.conf, a leaf for its Service names and a script with verifiers only", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    expect(objects.configMaps.get(K8S_NAMES.postgresConfig)?.["pg_hba.conf"]).toContain("hostssl all all 0.0.0.0/0 scram-sha-256");
    const store = objects.secret(K8S_NAMES.secretStore);
    const script = objects.secret(K8S_NAMES.postgresProvision)["provision.sql"] as string;
    expect(script).toContain("SCRAM-SHA-256$");
    expect(script).not.toContain(store["postgres-platform-password"] as string);
    expect(objects.secret(K8S_NAMES.postgresSuperuser).POSTGRES_PASSWORD).toBe(store[POSTGRES_SUPERUSER_SECRET] as string);
    expect(objects.secret(K8S_NAMES.postgresTls)["server.crt"]).toContain("BEGIN CERTIFICATE");
  });

  test("the managed Keycloak gets its database password, the bootstrap client and the installer's auth edge", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    const store = objects.secret(K8S_NAMES.secretStore);
    expect(objects.secret(K8S_NAMES.keycloakEnv)).toEqual({
      KC_DB_PASSWORD: store["postgres-keycloak-password"] as string,
      KC_BOOTSTRAP_ADMIN_CLIENT_ID: "libredb-bootstrap",
      KC_BOOTSTRAP_ADMIN_CLIENT_SECRET: store[STORE_KEYS.keycloakBootstrapSecret] as string,
    });
    const config = objects.secret(K8S_NAMES.keycloakConfig);
    expect(Object.keys(config).sort()).toEqual(
      [CLIENT_SECRET_NAMES.studio, CLIENT_SECRET_NAMES.platform, STORE_KEYS.keycloakBootstrapSecret, STORE_KEYS.firstAdminPassword, STORE_KEYS.userManagerPassword].sort(),
    );
    const caddyfile = objects.configMaps.get(K8S_NAMES.keycloakEdge)?.Caddyfile as string;
    expect(caddyfile).toContain("http://auth.libredb.test:8081 {");
    expect(caddyfile).toContain("@keycloak path /realms/libredb/* /resources/*");
    expect(caddyfile).not.toContain("platform.libredb.test");
  });

  test("a second run keeps every generated secret, the seal keys and the internal CA, and rewrites only derived objects", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    const store = objects.secret(K8S_NAMES.secretStore);
    const tls = objects.secret(K8S_NAMES.tls);
    objects.writes.length = 0;
    const lines = await bootstrap(objects);
    expect(objects.secret(K8S_NAMES.secretStore)).toEqual(store);
    expect(objects.secret(K8S_NAMES.tls)).toEqual(tls);
    expect(objects.writes).not.toContain(`secret/${K8S_NAMES.secretStore}`);
    expect(objects.writes).not.toContain(`secret/${K8S_NAMES.tls}`);
    expect(lines.join("\n")).not.toContain("secrets: stored");
  });

  test("refuses a run that changes an immutable field, such as postgres.mode", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    const external = installation(EXTERNAL_POSTGRES);
    await expect(bootstrap(objects, external, files({ [`${INPUT_DIR}/ca/postgres-ca.crt`]: (await createCa({ commonName: "corp", now: new Date() })).certPem }))).rejects.toThrow(UnsafeChangeError);
  });

  test("an AUTH_SECRET rotation passes the previous secret to Platform", async () => {
    const objects = new MemoryObjects();
    const previousFile = `${INPUT_DIR}/auth-secret-previous`;
    const config = installation({ platform: { organizationName: "Acme", licenseFile: `${INPUT_DIR}/license/license`, authSecretPreviousFile: previousFile } });
    await bootstrap(objects, config, files({ [previousFile]: "the-previous-auth-secret-of-32-characters" }));
    expect(objects.secret(K8S_NAMES.platformEnv).AUTH_SECRET_PREVIOUS).toBe("the-previous-auth-secret-of-32-characters");
  });

  test("refuses a missing license file", async () => {
    const objects = new MemoryObjects();
    await expect(bootstrap(objects, installation(), () => undefined)).rejects.toThrow("platform.licenseFile");
  });
});

describe("the bootstrap job with an external PostgreSQL and the site's Keycloak", () => {
  test("writes the DBA's provisioning script, puts the server's CA first in the bundle and takes the site's client secrets", async () => {
    const objects = new MemoryObjects();
    const postgresCa = await createCa({ commonName: "Corp PostgreSQL CA", now: new Date() });
    const config = installation({ ...EXTERNAL_POSTGRES, ...MANUAL_KEYCLOAK });
    await bootstrap(
      objects,
      config,
      files({
        [`${INPUT_DIR}/ca/postgres-ca.crt`]: postgresCa.certPem,
        [`${INPUT_DIR}/keycloak-clients/studio-client-secret`]: "corp-studio-secret\n",
        [`${INPUT_DIR}/keycloak-clients/platform-client-secret`]: "corp-platform-secret\n",
      }),
    );
    expect(objects.secrets.has(K8S_NAMES.postgresProvision)).toBe(false);
    expect(objects.secrets.has(K8S_NAMES.postgresSuperuser)).toBe(false);
    expect(objects.secrets.has(K8S_NAMES.keycloakEnv)).toBe(false);
    expect(objects.configMaps.has(K8S_NAMES.keycloakEdge)).toBe(false);
    expect(objects.secrets.has(K8S_NAMES.ingressTls("auth"))).toBe(false);
    const script = objects.secret(K8S_NAMES.postgresDbaScript)["provision.sql"] as string;
    expect(script).toContain("pg.corp.example:5432");
    expect(script).not.toContain("libredb_keycloak");
    const bundle = objects.configMaps.get(K8S_NAMES.caBundle)?.["ca.crt"] as string;
    // Prisma trusts only the first certificate of sslcert, so the external server's CA leads the bundle.
    expect(bundle.split("\n")[1]).toBe(postgresCa.certPem.split("\n")[1] as string);
    expect(objects.secret(STUDIO_SECRET)[STUDIO_SECRET_KEYS.oidcClientSecret]).toBe("corp-studio-secret");
    expect(objects.secret(K8S_NAMES.platformEnv).AUTH_KEYCLOAK_SECRET).toBe("corp-platform-secret");
    expect(objects.secret(K8S_NAMES.platformEnv).DATABASE_URL).toContain("@pg.corp.example:5432/");
  });

  test("a changed site client secret replaces the stored one on the next run", async () => {
    const objects = new MemoryObjects();
    const config = installation(MANUAL_KEYCLOAK);
    const secrets = (studio: string) =>
      files({
        [`${INPUT_DIR}/keycloak-clients/studio-client-secret`]: studio,
        [`${INPUT_DIR}/keycloak-clients/platform-client-secret`]: "corp-platform-secret",
      });
    await bootstrap(objects, config, secrets("first"));
    await bootstrap(objects, config, secrets("second"));
    expect(objects.secret(K8S_NAMES.secretStore)[CLIENT_SECRET_NAMES.studio]).toBe("second");
  });

  test("refuses a site client secret that is not mounted", async () => {
    await expect(bootstrap(new MemoryObjects(), installation(MANUAL_KEYCLOAK))).rejects.toThrow("keycloak.external.studioClientSecret");
  });

  test("refuses an external server with provisioning installer, which would bring an admin credential into the cluster", async () => {
    const config = installation({
      postgres: { mode: "external", external: { host: "pg.corp.example", adminUser: "postgres", adminPasswordEnv: "PG_ADMIN" } },
    });
    await expect(bootstrap(new MemoryObjects(), config)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("provisioning manual") });
  });

  test("an external Keycloak with provisioning installer gets generated client secrets and no accounts", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects, installation(INSTALLER_KEYCLOAK));
    const config = objects.secret(K8S_NAMES.keycloakConfig);
    expect(Object.keys(config).sort()).toEqual([CLIENT_SECRET_NAMES.studio, CLIENT_SECRET_NAMES.platform].sort());
    expect(objects.secret(K8S_NAMES.platformEnv).KEYCLOAK_ADMIN_URL).toBe("https://kc-admin.corp.example");
  });
});

describe("the bootstrap job's parts", () => {
  test("generatedNames adds the chart's own secrets to the installer's set", () => {
    expect(generatedNames(installation())).toEqual(
      expect.arrayContaining([STORE_KEYS.keycloakBootstrapSecret, STORE_KEYS.firstAdminPassword, STORE_KEYS.userManagerPassword]),
    );
    const site = generatedNames(installation(MANUAL_KEYCLOAK));
    expect(site).not.toContain(STORE_KEYS.keycloakBootstrapSecret);
    expect(site).not.toContain(STORE_KEYS.firstAdminPassword);
    expect(site).not.toContain(CLIENT_SECRET_NAMES.studio);
  });

  test("sealKeysOf issues the first key once and refuses an emptied store", () => {
    const first = sealKeysOf(undefined);
    expect(first.issued).toBe(true);
    expect(first.keys).toHaveLength(1);
    expect(sealKeysOf(JSON.stringify(first.keys))).toEqual({ keys: first.keys, issued: false });
    expect(() => sealKeysOf("[]")).toThrow("holds no seal key");
    expect(() => sealKeysOf("{}")).toThrow("holds no seal key");
  });

  test("convergeStore keeps a stored value and registers every value with the redactor", () => {
    const redactor = new Redactor();
    const stored = { [APP_SECRET_NAMES.platformAuthSecret]: "kept-auth-secret" };
    const { store, changed } = convergeStore(installation(), stored, { readFile: files(), env: {}, redactor });
    expect(store[APP_SECRET_NAMES.platformAuthSecret]).toBe("kept-auth-secret");
    expect(changed).not.toContain(APP_SECRET_NAMES.platformAuthSecret);
    expect(redactor.redact("kept-auth-secret")).toBe("[REDACTED]");
  });

  test("convergeTls re-issues a leaf close to its expiry and keeps the CA", async () => {
    const config = installation();
    const issued = await convergeTls(config, {}, new Date("2026-10-20T00:00:00Z"), () => {});
    const lines: string[] = [];
    const later = await convergeTls(config, issued.data, new Date("2029-01-05T00:00:00Z"), (line) => lines.push(line));
    expect(later.changed).toBe(true);
    expect(later.data["ca.crt"]).toBe(issued.data["ca.crt"] as string);
    expect(later.data["postgres.crt"]).not.toBe(issued.data["postgres.crt"] as string);
    expect(lines.join("\n")).toContain("days left");
    const kept = await convergeTls(config, issued.data, new Date("2026-10-21T00:00:00Z"), () => {});
    expect(kept.changed).toBe(false);
  });

  test("observedTls reads only the keys that exist", () => {
    expect(observedTls({ "ca.crt": "c" }, ["postgres"])).toEqual({ ca: { certPem: "c" }, leaves: { postgres: {} } });
  });

  test("caBundleOf refuses a configured CA file that is not mounted", async () => {
    const ca = await createCa({ commonName: "internal", now: new Date() });
    expect(() => caBundleOf(installation(EXTERNAL_POSTGRES), ca.certPem, () => undefined)).toThrow("does not exist");
  });

  test("the edge Caddyfile serves the auth site alone behind the ingress", () => {
    const caddyfile = keycloakEdgeCaddyfile(installation(), manifestFixture());
    expect(caddyfile).toContain("trusted_proxies static private_ranges");
    expect(caddyfile).toContain("respond 400");
  });

  test("the state round-trips through its Secret, and the first run records the immutable fields", async () => {
    const objects = new MemoryObjects();
    expect(await loadState(objects)).toEqual(emptyState());
    const state = checkInstallation(emptyState(), installation());
    expect(state.installation).toBeDefined();
    await saveState(objects, state);
    expect(objects.secret(K8S_NAMES.state)[STATE_KEY]).toEndWith("\n");
    expect(await loadState(objects)).toEqual(state);
  });
});

describe("the bootstrap job across upgrades", () => {
  const SECRETS_MODE = { tls: { mode: "external", caBundleFile: `${INPUT_DIR}/ca/tls-ca.crt`, external: { trustedProxies: ["private_ranges"] } } };

  test("asks to restart only the workloads whose inputs changed, and nothing on a run that changes nothing", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    // A first install asks for every reader; the restart job then finds their pods started after the change.
    expect(pendingRestartsOf(objects.secret(K8S_NAMES.state))?.workloads).toHaveLength(4);
    await runRestarts(objects, "1.0.0", () => new Date(), () => {});
    expect(pendingRestartsOf(objects.secret(K8S_NAMES.state))).toBeUndefined();
    const lines = await bootstrap(objects);
    expect(pendingRestartsOf(objects.secret(K8S_NAMES.state))).toBeUndefined();
    expect(lines.join("\n")).not.toContain("asked to restart");
    const renewed = "ldl1.fedcba9876543210.eyJpZCI6IlJFTkVXRUQifQ.c2lnbmF0dXJl";
    await bootstrap(objects, installation(), files({ [`${INPUT_DIR}/license/license`]: renewed }));
    expect(pendingRestartsOf(objects.secret(K8S_NAMES.state))?.workloads).toEqual([WORKLOADS.platform]);
  });

  test("a renewed PostgreSQL leaf asks to restart the server", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    await runRestarts(objects, "1.0.0", () => new Date(), () => {});
    await bootstrap(objects, installation(), files(), new Date("2029-01-05T00:00:00Z"));
    expect(pendingRestartsOf(objects.secret(K8S_NAMES.state))?.workloads).toEqual([WORKLOADS.postgres]);
  });

  test("the restart job restarts old pods, skips pods started after the change and absent workloads, then clears the request", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects, installation(), files(), new Date("2026-10-20T00:00:00Z"));
    objects.workloads.add("deployments/libredb-platform");
    objects.workloads.add("deployments/libredb-studio");
    objects.pods.set("deployments/libredb-studio", [new Date("2026-10-20T00:05:00Z")]);
    const lines: string[] = [];
    await runRestarts(objects, "1.0.0", () => new Date("2026-10-20T00:10:00Z"), (line) => lines.push(line));
    expect(objects.restarts).toEqual(["deployments/libredb-platform"]);
    expect(lines).toContain("deployments/libredb-studio started after its inputs changed");
    expect(lines).toContain("deployments/keycloak does not exist");
    expect(pendingRestartsOf(objects.secret(K8S_NAMES.state))).toBeUndefined();
    expect(objects.secret(K8S_NAMES.state)[RELEASE_KEY]).toBeDefined();
    const again: string[] = [];
    await runRestarts(objects, "1.0.0", () => new Date(), (line) => again.push(line));
    expect(again).toEqual(["no restart asked for", "the installation runs LibreDB 1.0.0"]);
  });

  test("a restart request survives a run that fails after it, and a later run adds to it with the newer time", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    await runRestarts(objects, "1.0.0", () => new Date(), () => {});
    const renewed = (id: string) => `ldl1.fedcba9876543210.${Buffer.from(JSON.stringify({ id })).toString("base64url")}.c2lnbmF0dXJl`;
    await bootstrap(objects, installation(), files({ [`${INPUT_DIR}/license/license`]: renewed("A") }), new Date("2026-10-21T00:00:00Z"));
    const failing = Object.assign(Object.create(Object.getPrototypeOf(objects)), objects) as MemoryObjects;
    failing.restart = async () => {
      throw new Error("the API server is down");
    };
    objects.workloads.add("deployments/libredb-platform");
    await expect(runRestarts(failing, "1.0.0", () => new Date(), () => {})).rejects.toThrow("down");
    expect(pendingRestartsOf(objects.secret(K8S_NAMES.state))?.workloads).toEqual([WORKLOADS.platform]);
    await bootstrap(objects, installation(INSTALLER_KEYCLOAK), files({ [`${INPUT_DIR}/license/license`]: renewed("A") }), new Date("2026-10-22T00:00:00Z")).catch(() => {});
    expect(addPendingRestarts(pendingRestartsOf(objects.secret(K8S_NAMES.state)), [WORKLOADS.studio], new Date("2026-10-23T00:00:00Z"))).toEqual({
      since: "2026-10-23T00:00:00.000Z",
      workloads: [WORKLOADS.platform, WORKLOADS.studio],
    });
  });

  test("a switch to tls.mode secrets writes no ingress Secret any more, though the store keeps the old leaves", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    for (const name of [K8S_NAMES.ingressTls("platform"), K8S_NAMES.ingressTls("studio"), K8S_NAMES.ingressTls("auth")]) objects.secrets.delete(name);
    const ca = await createCa({ commonName: "site", now: new Date() });
    await bootstrap(objects, installation(SECRETS_MODE), files({ [`${INPUT_DIR}/ca/tls-ca.crt`]: ca.certPem }));
    expect(objects.secrets.has(K8S_NAMES.ingressTls("platform"))).toBe(false);
    expect(objects.secret(K8S_NAMES.tls)["platform.crt"]).toBeDefined();
  });

  test("Studio's network environment holds the installer's NO_PROXY, and the proxy when one is set", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects, installation({ network: { httpsProxy: "http://proxy.corp:3128" } }));
    const env = objects.secret(K8S_NAMES.studioNetworkEnv);
    expect(env.HTTPS_PROXY).toBe("http://proxy.corp:3128");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    expect(env.NO_PROXY).toContain("libredb-postgres");
    expect(env.NO_PROXY).toBe(objects.secret(K8S_NAMES.platformEnv).NO_PROXY as string);
  });

  test("the release is recorded once the restart job ran, kept by later state saves, and an older one is refused", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    // A failed upgrade, whose restart job never ran, records nothing, so its --atomic rollback is not refused.
    expect(objects.secret(K8S_NAMES.state)[RELEASE_KEY]).toBeUndefined();
    await runRestarts(objects, manifestFixture().version, () => new Date(), () => {});
    expect(objects.secret(K8S_NAMES.state)[RELEASE_KEY]).toBe(manifestFixture().version);
    await saveState(objects, emptyState());
    expect(objects.secret(K8S_NAMES.state)[RELEASE_KEY]).toBe(manifestFixture().version);
    await expect(checkRelease(objects, "0.9.0")).rejects.toThrow("a downgrade is not supported");
    await expect(checkRelease(objects, "0.9.0")).rejects.toMatchObject({ name: "RefusedError", exitCode: 6 });
    await checkRelease(objects, "9.0.0");
  });

  test("sameData compares keys and values", () => {
    expect(sameData({ a: "1" }, { a: "1" })).toBe(true);
    expect(sameData({ a: "1" }, { a: "2" })).toBe(false);
    expect(sameData({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  });
});

describe("the bootstrap job's seal key rotation", () => {
  type StoredKey = { kid: string; publicKey: string; state: string };
  const storedKeys = (objects: MemoryObjects) => JSON.parse(objects.secret(K8S_NAMES.secretStore)[STORE_KEYS.sealKeys] as string) as StoredKey[];
  const keyringSize = (objects: MemoryObjects) =>
    (JSON.parse(objects.secret(STUDIO_SECRET)[STUDIO_SECRET_KEYS.governancePrivateKeys] as string) as { keys: string[] }).keys.length;
  const sealing = (sealKeys: Record<string, unknown>) => installation({ bridge: { sealKeys } });
  const uses = (rows: unknown[]) => files({ [SEAL_ENVELOPES_FILE]: `libredb-result envelope-uses ${JSON.stringify(rows)}\n` });

  test("walks the runbook: issue a key, switch Platform to it, retire the old one, each step once", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    const [old] = storedKeys(objects) as [StoredKey];

    const issued = await bootstrap(objects, sealing({ issueNew: true }));
    const [, fresh] = storedKeys(objects) as [StoredKey, StoredKey];
    expect(issued).toContain(`seal keys: issued seal key ${fresh.kid} into the Studio keyring`);
    expect(keyringSize(objects)).toBe(2);
    // Platform keeps sealing to the oldest live key until activeKid names the new one.
    expect(objects.secret(K8S_NAMES.platformEnv).BRIDGE_SEAL_PUBLIC_KEY).toBe(old.publicKey);
    // The same values again issue no second key.
    await bootstrap(objects, sealing({ issueNew: true }));
    expect(storedKeys(objects)).toHaveLength(2);

    await bootstrap(objects, sealing({ issueNew: false, activeKid: fresh.kid }));
    expect(objects.secret(K8S_NAMES.platformEnv).BRIDGE_SEAL_PUBLIC_KEY).toBe(fresh.publicKey);
    expect(pendingRestartsOf(objects.secret(K8S_NAMES.state))?.workloads).toContainEqual(WORKLOADS.platform);

    const retired = await bootstrap(objects, sealing({ issueNew: false, activeKid: fresh.kid, retire: [old.kid] }), uses([]));
    expect(retired).toContain(`seal keys: retired seal key ${old.kid}: out of the Studio keyring, kept in the secret store`);
    expect(storedKeys(objects).map((key) => [key.kid, key.state])).toEqual([
      [old.kid, "retired"],
      [fresh.kid, "live"],
    ]);
    expect(keyringSize(objects)).toBe(1);
    // Retiring an already retired kid needs neither the envelopes nor a change.
    const again = await bootstrap(objects, sealing({ issueNew: false, activeKid: fresh.kid, retire: [old.kid] }), files());
    expect(again.join("\n")).not.toContain("seal keys:");
  });

  test("refuses with exit 6 a retirement while a connection still uses the kid, and changes nothing", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    await bootstrap(objects, sealing({ issueNew: true }));
    const [old, fresh] = storedKeys(objects) as [StoredKey, StoredKey];
    const before = objects.secret(K8S_NAMES.secretStore);
    const config = sealing({ activeKid: fresh.kid, retire: [old.kid] });
    const run = bootstrap(objects, config, uses([{ kid: old.kid, connectionId: "c1", name: "orders" }]));
    await expect(run).rejects.toMatchObject({ exitCode: 6 });
    await expect(bootstrap(objects, config, uses([{ kid: old.kid, connectionId: "c1", name: "orders" }]))).rejects.toThrow(
      `kid ${old.kid} still seals credentials of 1 connection in bridge.connections_v1: orders (c1)`,
    );
    expect(objects.secret(K8S_NAMES.secretStore)).toEqual(before);
  });

  test("refuses to retire the active kid, and needs the init container's output for a live kid", async () => {
    const objects = new MemoryObjects();
    await bootstrap(objects);
    const [only] = storedKeys(objects) as [StoredKey];
    await expect(bootstrap(objects, sealing({ retire: [only.kid] }), uses([]))).rejects.toMatchObject({ exitCode: 6 });
    await bootstrap(objects, sealing({ issueNew: true }));
    const [, fresh] = storedKeys(objects) as [StoredKey, StoredKey];
    await expect(bootstrap(objects, sealing({ activeKid: fresh.kid, retire: [only.kid] }))).rejects.toThrow(
      `retiring seal key ${only.kid} needs the connections each still seals`,
    );
  });

  test("rotateSealKeys leaves the keys alone without bridge.sealKeys", () => {
    const keys = sealKeysOf(undefined).keys;
    expect(rotateSealKeys(keys, installation(), files())).toEqual({ keys, done: [] });
  });
});
