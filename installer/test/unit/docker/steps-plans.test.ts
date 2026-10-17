import { describe, expect, test } from "bun:test";
import { planImages } from "../../../src/docker/images";
import {
  dockerSecretNames,
  planSealKey,
  planSecrets,
  planSiteSecrets,
  siteSecretReferences,
  platformSealKey,
  POSTGRES_SUPERUSER_SECRET,
} from "../../../src/docker/secrets";
import { dockerSupportIssues } from "../../../src/docker/support";
import { tlsActions } from "../../../src/docker/tls";
import { loadConfig } from "../../../src/config/load";
import { join } from "node:path";
import { MissingCredentialError } from "../../../src/keycloak/external";
import { EXTERNAL_KEYCLOAK_SETS, MANUAL_KEYCLOAK_SETS } from "../keycloak/fixture";

const configs = join(import.meta.dir, "..", "..", "fixtures", "configs");
const fixture = join(configs, "docker.yaml");

describe("planImages", () => {
  test("pulls only the images the engine does not hold", () => {
    expect(
      planImages([
        { reference: "caddy@sha256:1", present: true },
        { reference: "postgres@sha256:2", present: false },
      ]),
    ).toEqual([{ kind: "image", reference: "postgres@sha256:2", summary: "pull postgres@sha256:2" }]);
  });
});

describe("planSecrets", () => {
  const name = POSTGRES_SUPERUSER_SECRET;
  const names = [name];

  test("generates a secret the store lacks", () => {
    expect(planSecrets(names, {}, {})).toEqual([{ kind: "generate", name, summary: `generate secret ${name}` }]);
  });

  test("records a fingerprint the state lacks or holds stale, and plans nothing once it matches", () => {
    const stored = { [name]: "a".repeat(64) };
    expect(planSecrets(names, stored, {})[0]?.kind).toBe("record");
    expect(planSecrets(names, stored, { [name]: "b".repeat(64) })[0]?.kind).toBe("record");
    expect(planSecrets(names, stored, stored)).toEqual([]);
  });
});

describe("dockerSecretNames", () => {
  test("names the superuser password, one password per provisioned role, the Keycloak one only when it is managed, both app client secrets and the app secrets", () => {
    expect(dockerSecretNames(loadConfig({ file: fixture, sets: [] }))).toEqual([
      "postgres-superuser-password",
      "postgres-owner-password",
      "postgres-platform-password",
      "postgres-studio-password",
      "postgres-keycloak-password",
      "postgres-backup-password",
      "keycloak-client-libredb-studio",
      "keycloak-client-libredb-platform",
      "platform-auth-secret",
      "studio-jwt-secret",
      "studio-storage-encryption-key",
    ]);
    expect(dockerSecretNames(loadConfig({ file: fixture, sets: [...EXTERNAL_KEYCLOAK_SETS] }))).not.toContain(
      "postgres-keycloak-password",
    );
  });

  test("an external PostgreSQL has no superuser password, and keeps a generated password per provisioned role", () => {
    const sets = ["postgres.mode=external", "postgres.external.host=db.corp", "postgres.external.adminUser=dba"];
    const names = dockerSecretNames(loadConfig({ file: fixture, sets }));
    expect(names).not.toContain("postgres-superuser-password");
    expect(names.slice(0, 5)).toEqual([
      "postgres-owner-password",
      "postgres-platform-password",
      "postgres-studio-password",
      "postgres-keycloak-password",
      "postgres-backup-password",
    ]);
  });
});

describe("site client secrets", () => {
  const studio = "keycloak-client-libredb-studio";
  const platform = "keycloak-client-libredb-platform";

  test("provisioning manual generates no app client secret and reads both from their references", () => {
    const config = loadConfig({ file: fixture, sets: [...MANUAL_KEYCLOAK_SETS] });
    expect(dockerSecretNames(config)).not.toContain(studio);
    expect(dockerSecretNames(config)).not.toContain(platform);
    expect(siteSecretReferences(config)).toEqual([
      { name: studio, reference: { path: "keycloak.external.studioClientSecret", env: "CORP_STUDIO_CLIENT_SECRET", file: undefined } },
      {
        name: platform,
        reference: { path: "keycloak.external.platformClientSecret", env: undefined, file: "/root/corp-platform-client-secret" },
      },
    ]);
    expect(siteSecretReferences(loadConfig({ file: fixture, sets: [...EXTERNAL_KEYCLOAK_SETS] }))).toEqual([]);
    expect(siteSecretReferences(loadConfig({ file: fixture, sets: [] }))).toEqual([]);
  });

  test("stores a supplied secret the store lacks or holds another value of, and records its fingerprint once stored", () => {
    const supplied = { fingerprint: "a".repeat(64) };
    const entries = [{ name: studio, path: "keycloak.external.studioClientSecret", supplied }];
    const store = {
      kind: "store" as const,
      name: studio,
      summary: "store the secret of keycloak-client-libredb-studio from keycloak.external.studioClientSecretEnv or File",
    };
    expect(planSiteSecrets(entries, {}, {})).toEqual({ actions: [store], warnings: [] });
    expect(planSiteSecrets(entries, { [studio]: "b".repeat(64) }, {})).toEqual({ actions: [store], warnings: [] });
    expect(planSiteSecrets(entries, { [studio]: supplied.fingerprint }, {}).actions.map((action) => action.kind)).toEqual(["record"]);
    expect(planSiteSecrets(entries, { [studio]: supplied.fingerprint }, { [studio]: supplied.fingerprint })).toEqual({
      actions: [],
      warnings: [],
    });
  });

  test("a run without the reference keeps the stored secret with a warning, and refuses with exit 2 when none is stored", () => {
    const missing = "the environment variable KC_STUDIO that keycloak.external.studioClientSecretEnv names is not set";
    const entries = [{ name: studio, path: "keycloak.external.studioClientSecret", supplied: { missing } }];
    const fingerprint = "c".repeat(64);
    expect(planSiteSecrets(entries, { [studio]: fingerprint }, { [studio]: fingerprint })).toEqual({
      actions: [],
      warnings: [`${missing}, so the installer keeps the secret of keycloak.external.studioClientSecret it stored before`],
    });
    expect(() => planSiteSecrets(entries, {}, {})).toThrow(MissingCredentialError);
    expect(() => planSiteSecrets(entries, {}, {})).toThrow(
      `${missing}; provisioning manual needs the secret of keycloak.external.studioClientSecret, which the site's Keycloak generated`,
    );
  });
});

describe("planSealKey", () => {
  test("issues the first seal key only when the store never issued one, also when every key is retired", () => {
    expect(planSealKey([])).toEqual([
      {
        kind: "seal-key",
        name: "seal-key",
        summary: "issue the first seal key, for the Studio keyring and BRIDGE_SEAL_PUBLIC_KEY",
      },
    ]);
    expect(planSealKey([{ kid: "0123456789abcdef", state: "live" }])).toEqual([]);
    expect(planSealKey([{ kid: "0123456789abcdef", state: "retired" }])).toEqual([]);
  });
});

describe("platformSealKey", () => {
  test("gives Platform the oldest live key, so a key issued later reaches Studio's keyring first", () => {
    const keys = [
      { kid: "aaaaaaaaaaaaaaaa", state: "retired" as const },
      { kid: "bbbbbbbbbbbbbbbb", state: "live" as const },
      { kid: "cccccccccccccccc", state: "live" as const },
    ];
    expect(platformSealKey(keys).kid).toBe("bbbbbbbbbbbbbbbb");
  });

  test("refuses a store without a live key", () => {
    expect(() => platformSealKey([{ kid: "aaaaaaaaaaaaaaaa", state: "retired" as const }])).toThrow(
      "the secret store holds no live seal key",
    );
  });
});

describe("tlsActions", () => {
  test("creates the CA and issues only the leaves the plan does not keep", () => {
    expect(
      tlsActions({
        ca: "create",
        leaves: [
          { name: "studio", hosts: ["studio.example.com"], action: "issue", reasons: ["the internal CA is new"] },
          { name: "postgres", hosts: ["postgres"], action: "keep", daysLeft: 800 },
        ],
      }),
    ).toEqual([
      { kind: "ca", summary: "create the internal CA" },
      {
        kind: "leaf",
        leaf: { name: "studio", hosts: ["studio.example.com"] },
        summary: "issue the studio certificate for studio.example.com: the internal CA is new",
      },
    ]);
    expect(tlsActions({ ca: "keep", leaves: [] })).toEqual([]);
  });
});

describe("dockerSupportIssues", () => {
  test("accepts the Docker fixture", () => {
    expect(dockerSupportIssues(loadConfig({ file: fixture, sets: [] }))).toEqual([]);
  });

  test("refuses Kubernetes mode, and accepts every TLS mode, an external Keycloak and an external PostgreSQL", () => {
    expect(dockerSupportIssues(loadConfig({ file: join(configs, "docker-minimal.yaml"), sets: ["mode=kubernetes"] }))).toEqual([
      "mode: this installer build applies mode docker only, and the configuration sets kubernetes",
    ]);
    const externalPostgres = ["postgres.mode=external", "postgres.external.host=db.corp", "postgres.external.adminUser=dba"];
    expect(
      dockerSupportIssues(
        loadConfig({
          file: join(configs, "docker-external-tls.yaml"),
          sets: [...externalPostgres, ...EXTERNAL_KEYCLOAK_SETS],
        }),
      ),
    ).toEqual([]);
    expect(dockerSupportIssues(loadConfig({ file: fixture, sets: [...EXTERNAL_KEYCLOAK_SETS] }))).toEqual([]);
    expect(dockerSupportIssues(loadConfig({ file: fixture, sets: externalPostgres }))).toEqual([]);
  });
});
