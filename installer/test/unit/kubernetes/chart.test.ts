// The Helm chart charts/libredb-platform against the installer it drives, through the real `helm template` output:
// every render guard, the installation document the jobs validate with the installer's schema, the image and Studio
// chart pins of the release manifest, the environments of Studio and Keycloak against the installer's renderers, the
// bootstrap Role against every object the bootstrap job writes, and the pod security of every workload.
import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import { parseInstallation } from "../../../src/config/schema";
import { runBootstrap } from "../../../src/kubernetes/bootstrap";
import { computeDesired } from "../../../src/model/desired";
import { renderStudioEnv } from "../../../src/model/studio-env";
import { parseReleaseManifest } from "../../../src/release/manifest";
import { composeTrust, renderCompose } from "../../../src/render/compose";
import manifestDocument from "../../../release/release.config.json" with { type: "json" };
import { files, MemoryObjects } from "./fixture";
import { Redactor } from "../../../src/log/redact";
import { INPUT_DIR, WORKLOADS } from "../../../src/kubernetes/names";
import { deleteCanaryScript, envelopeUsesScript } from "../../../src/secrets/seal-rotation";
import { SEAL_ENVELOPES_FILE } from "../../../src/kubernetes/bootstrap";
import { createCa } from "../../../src/tls/ca";

const CHART = join(import.meta.dir, "..", "..", "..", "..", "charts", "libredb-platform");
const LICENSE = "ldl1.0123456789abcdef.eyJpZCI6IlRFU1QifQ.c2lnbmF0dXJl";
const manifest = parseReleaseManifest(manifestDocument);

type Doc = { kind: string; metadata: { name: string; annotations?: Record<string, string> }; spec?: any; data?: Record<string, string>; rules?: any[] };

const BASE = [
  "hosts.platform=platform.libredb.test",
  "hosts.studio=studio.libredb.test",
  "hosts.auth=auth.libredb.test",
  "platform.organizationName=Acme",
  `platform.license.value=${LICENSE}`,
  "studio.config.oidcIssuer=https://auth.libredb.test/realms/libredb",
  "studio.ingress.hosts[0].host=studio.libredb.test",
  "studio.ingress.hosts[0].paths[0].path=/",
  "studio.ingress.hosts[0].paths[0].pathType=Prefix",
  "studio.ingress.tls[0].secretName=libredb-tls-studio",
  "studio.ingress.tls[0].hosts[0]=studio.libredb.test",
];

function helm(sets: readonly string[], args: readonly string[] = []): string {
  return execFileSync("helm", ["template", "libredb", CHART, "-n", "libredb", ...sets.flatMap((set) => ["--set", set]), ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function render(sets: readonly string[] = [], args: readonly string[] = []): Doc[] {
  return parseAllDocuments(helm([...BASE, ...sets], args))
    .map((doc) => doc.toJS() as Doc | null)
    .filter((doc): doc is Doc => doc !== null);
}

function failure(sets: readonly string[]): string {
  try {
    helm([...BASE, ...sets]);
  } catch (error) {
    return String((error as { stderr?: string }).stderr);
  }
  throw new Error("the render succeeded");
}

function find(docs: Doc[], kind: string, name: string): Doc {
  const doc = docs.find((candidate) => candidate.kind === kind && candidate.metadata.name === name);
  if (doc === undefined) throw new Error(`no ${kind} ${name}`);
  return doc;
}

function installationOf(docs: Doc[]) {
  return JSON.parse(find(docs, "ConfigMap", "libredb-bootstrap-chart").data?.["installation.json"] as string);
}

beforeAll(() => {
  // The Studio chart dependency: the one `bun run embed` downloaded and checked against the manifest's sha256 when it
  // exists, as in CI, or else Helm's build from Chart.lock.
  const archive = `libredb-studio-${manifest.studioChart.version}.tgz`;
  if (existsSync(join(CHART, "charts", archive))) return;
  const embedded = join(import.meta.dir, "..", "..", "..", "generated", archive);
  if (existsSync(embedded)) {
    mkdirSync(join(CHART, "charts"), { recursive: true });
    copyFileSync(embedded, join(CHART, "charts", archive));
  } else {
    execFileSync("helm", ["dependency", "build", CHART], { stdio: "ignore" });
  }
});

describe("the chart's pins", () => {
  test("its images are the release manifest's, by digest", () => {
    const values = parse(readFileSync(join(CHART, "values.yaml"), "utf8"));
    const pinned = (entry: { repository: string; version: string; digest: string }) => ({ repository: entry.repository, tag: `${entry.version}@${entry.digest}` });
    const pick = (image: { repository: string; tag: string }) => ({ repository: image.repository, tag: image.tag });
    expect(pick(values.platform.image)).toEqual(pinned(manifest.images.platform));
    expect(pick(values.studio.image)).toEqual(pinned(manifest.images.studio));
    expect(pick(values.keycloak.managed.image)).toEqual(pinned(manifest.images.keycloak));
    expect(pick(values.postgresql.managed.image)).toEqual(pinned(manifest.images.postgres));
    expect(pick(values.keycloak.managed.edge.image)).toEqual(pinned(manifest.images.edge));
  });

  test("its appVersion is the release, and its Studio dependency the manifest's chart with its sha256", () => {
    const chart = parse(readFileSync(join(CHART, "Chart.yaml"), "utf8"));
    expect(chart.appVersion).toBe(manifest.version);
    const studio = chart.dependencies.find((dependency: { name: string }) => dependency.name === "libredb-studio");
    expect({ version: studio.version, repository: studio.repository }).toEqual({
      version: manifest.studioChart.version,
      repository: manifest.studioChart.repository,
    });
    const archive = readFileSync(join(CHART, "charts", `libredb-studio-${manifest.studioChart.version}.tgz`));
    expect(new Bun.CryptoHasher("sha256").update(archive).digest("hex")).toBe(manifest.studioChart.sha256);
  });
});

describe("the chart's render guards", () => {
  test.each([
    [["hosts.auth="], "hosts.auth is required"],
    [["platform.organizationName="], "platform.organizationName is required"],
    [["platform.license.value="], "platform.license is required"],
    [["platform.license.value=not-a-token"], "must hold the license token alone"],
    [["tls.mode=letsencrypt"], "tls.mode must be generated or secrets"],
    [["tls.mode=secrets"], "tls.mode secrets needs tls.secrets.platform"],
    [["tls.mode=secrets", "tls.secrets.platform=a", "tls.secrets.studio=b", "tls.secrets.auth=c"], "tls.mode secrets needs tls.caBundle"],
    [["tls.mode=secrets", "tls.secrets.platform=a", "tls.secrets.studio=b"], "needs tls.secrets.auth"],
    [["postgresql.mode=cloud"], "postgresql.mode must be managed or external"],
    [["postgresql.mode=external"], "postgresql.mode external needs postgresql.external.host"],
    [["keycloak.mode=cloud"], "keycloak.mode must be managed or external"],
    [["keycloak.mode=external"], "keycloak.mode external needs keycloak.external.baseUrl"],
    [["keycloak.mode=external", "keycloak.external.baseUrl=https://auth.libredb.test", "keycloak.external.provisioning=auto"], "must be installer or manual"],
    [["keycloak.mode=external", "keycloak.external.baseUrl=https://auth.libredb.test"], "needs keycloak.external.adminSecret"],
    [["keycloak.mode=external", "keycloak.external.baseUrl=https://auth.libredb.test", "keycloak.external.adminSecret=kc"], "needs exactly one of keycloak.external.adminClientId and keycloak.external.adminUser"],
    [["keycloak.mode=external", "keycloak.external.baseUrl=https://auth.libredb.test", "keycloak.external.adminSecret=kc", "keycloak.external.adminUser=a", "keycloak.external.adminClientId=c"], "needs exactly one of"],
    [["network.httpsProxy=http://user:secret@proxy.corp:3128"], "network.httpsProxy must not hold credentials"],
    [["network.httpsProxy=HTTP://user:secret@proxy.corp:3128"], "network.httpsProxy must not hold credentials"],
    [["studio.fullnameOverride=studio"], "studio.fullnameOverride must stay libredb-studio"],
    [["studio.ingress.tls[0].secretName=other"], "studio.ingress.tls must hold one entry with secretName libredb-tls-studio and hosts [studio.libredb.test]"],
    [["studio.ingress.tls[0].hosts[0]=other.libredb.test"], "studio.ingress.tls must hold one entry"],
    [["tls.mode=secrets", "tls.secrets.platform=a", "tls.secrets.studio=b", "tls.secrets.auth=c", "tls.caBundle=PEM"], "studio.ingress.tls must hold one entry with secretName b"],
    [["keycloak.mode=external", "keycloak.external.baseUrl=https://auth.libredb.test", "keycloak.external.provisioning=manual"], "needs keycloak.external.clientSecretsSecret"],
    [["studio.config.oidcIssuer=https://other/realms/libredb"], "studio.config.oidcIssuer must be https://auth.libredb.test/realms/libredb"],
    [["studio.secrets.existingSecret=mine"], "studio.secrets.existingSecret must stay libredb-studio-env"],
    [["studio.ingress.hosts[0].host=other.libredb.test"], "studio.ingress.hosts must hold exactly one host"],
  ])("%j fails naming the value", (sets, message) => {
    expect(failure(sets as string[])).toContain(message as string);
  });
});

describe("the installation document", () => {
  test.each([
    ["managed PostgreSQL and Keycloak", []],
    ["an external PostgreSQL with its CA", ["postgresql.mode=external", "postgresql.external.host=pg.corp.example", "postgresql.external.caBundle=PEM"]],
    [
      "the site's Keycloak, provisioning manual",
      ["keycloak.mode=external", "keycloak.external.baseUrl=https://auth.libredb.test", "keycloak.external.provisioning=manual", "keycloak.external.clientSecretsSecret=kc"],
    ],
    [
      "the site's Keycloak, provisioning installer with an admin user",
      ["keycloak.mode=external", "keycloak.external.baseUrl=https://auth.libredb.test", "keycloak.external.adminSecret=kc", "keycloak.external.adminUser=admin", "keycloak.external.caBundle=PEM"],
    ],
    [
      "TLS Secrets of the site",
      ["tls.mode=secrets", "tls.secrets.platform=a", "tls.secrets.studio=b", "tls.secrets.auth=c", "tls.caBundle=PEM", "studio.ingress.tls[0].secretName=b", "platform.queryLogRetentionDays=30", "network.httpsProxy=http://proxy.corp:3128"],
    ],
  ])("with %s passes the installer's schema", (_name, sets) => {
    const document = installationOf(render(sets as string[]));
    expect(() => parseInstallation(document)).not.toThrow();
    expect(document.mode).toBe("kubernetes");
    expect(JSON.stringify(document)).not.toContain(LICENSE);
  });

  test("the first accounts follow keycloak.firstAdmin.enabled and keycloak.userManager.enabled when set", () => {
    const document = installationOf(render(["keycloak.firstAdmin.enabled=false", "keycloak.userManager.enabled=true"]));
    expect(parseInstallation(document).keycloak.firstAdmin.enabled).toBe(false);
  });
});

describe("the seal key and AUTH_SECRET rotations", () => {
  const OLD = "0123456789abcdef";
  const NEW = "fedcba9876543210";
  const podOf = (doc: Doc) => doc.spec.template.spec;

  test("platform.sealKeys becomes bridge.sealKeys, and by default no job reaches the database for it", () => {
    const defaults = render();
    expect(parseInstallation(installationOf(defaults)).bridge.sealKeys).toEqual({ issueNew: false, retire: [] });
    expect(podOf(find(defaults, "Job", "libredb-bootstrap")).initContainers).toBeUndefined();
    expect(podOf(find(defaults, "Job", "libredb-restart")).initContainers).toBeUndefined();
    const issuing = parseInstallation(installationOf(render(["platform.sealKeys.issueNew=true", `platform.sealKeys.activeKid=${NEW}`])));
    expect(issuing.bridge.sealKeys).toEqual({ issueNew: true, activeKid: NEW, retire: [] });
  });

  test("a retirement runs the installer's own SQL: the envelope query before the bootstrap, the canary delete after the release", () => {
    const docs = render([`platform.sealKeys.activeKid=${NEW}`, `platform.sealKeys.retire[0]=${OLD}`, `platform.sealKeys.retire[1]=${NEW.replace("f", "e")}`]);
    const kids = [OLD, NEW.replace("f", "e")];
    expect(parseInstallation(installationOf(docs)).bridge.sealKeys.retire).toEqual(kids);
    expect(find(docs, "ConfigMap", "libredb-bootstrap-chart").data?.["seal-envelopes.sql"]).toBe(envelopeUsesScript(kids));
    expect(find(docs, "ConfigMap", "libredb-chart").data?.["seal-canary.sql"]).toBe(kids.map(deleteCanaryScript).join(""));
    const bootstrap = podOf(find(docs, "Job", "libredb-bootstrap"));
    expect(bootstrap.initContainers.map((container: { name: string }) => container.name)).toEqual(["seal-envelopes"]);
    expect(bootstrap.initContainers[0].command[2]).toContain(`-f /etc/libredb/chart/seal-envelopes.sql > ${SEAL_ENVELOPES_FILE}`);
    const restart = podOf(find(docs, "Job", "libredb-restart"));
    expect(restart.initContainers[0].command[2]).toContain("-f /etc/libredb/chart/seal-canary.sql");
    for (const pod of [bootstrap, restart]) {
      const init = pod.initContainers[0];
      expect(init.env).toEqual([{ name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "libredb-platform-migrate-env", key: "DATABASE_URL" } } }]);
      // libpq gets the password in PGPASSWORD, never on psql's command line.
      expect(init.command[2]).toContain('export PGPASSWORD="${rest%%@*}"');
      expect(pod.volumes.find((volume: { name: string }) => volume.name === "installation-ca").configMap.name).toBe("libredb-ca");
    }
  });

  test("the retirement's SQL waits for a connection, which a new pod's network policy may refuse at first, and runs once", () => {
    const docs = render([`platform.sealKeys.activeKid=${NEW}`, `platform.sealKeys.retire[0]=${OLD}`]);
    const work = mkdtempSync(join(tmpdir(), "libredb-seal-sql-"));
    // A psql that refuses the first two connections, as kube-router does until it has the pod's address, and records
    // each script it runs; SCRIPT_EXIT is what the script run exits with.
    writeFileSync(
      join(work, "psql"),
      [
        "#!/bin/sh",
        `n=$(cat "${work}/tries" 2>/dev/null || echo 0); echo $((n + 1)) > "${work}/tries"`,
        '[ "$n" -ge 2 ] || exit 2',
        `case " $* " in *" -f "*) echo run >> "${work}/runs"; exit "$SCRIPT_EXIT" ;; esac`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const run = (pod: Doc, scriptExit: number) => {
      rmSync(join(work, "tries"), { force: true });
      rmSync(join(work, "runs"), { force: true });
      const script = (podOf(pod).initContainers[0].command[2] as string).replaceAll(SEAL_ENVELOPES_FILE, join(work, "out"));
      const result = Bun.spawnSync(["/bin/sh", "-c", script], {
        env: { PATH: `${work}:/usr/bin:/bin`, SCRIPT_EXIT: String(scriptExit), DATABASE_URL: "postgresql://libredb_platform:pw@libredb-postgres:5432/libredb?schema=platform" },
      });
      const runs = existsSync(join(work, "runs")) ? readFileSync(join(work, "runs"), "utf8").trim().split("\n").length : 0;
      return { code: result.exitCode, runs };
    };
    try {
      for (const job of ["libredb-bootstrap", "libredb-restart"]) {
        const pod = find(docs, "Job", job);
        expect(run(pod, 0), job).toEqual({ code: 0, runs: 1 });
        // A failing script is the refusal itself, so it is never run again.
        expect(run(pod, 3), job).toEqual({ code: 3, runs: 1 });
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    // Each of the four runs waits 1 s per refused connection.
  }, 30_000);

  test("a kid that is no seal key id fails the render, naming the value", () => {
    expect(failure(["platform.sealKeys.retire[0]=x'; DROP TABLE y;--"])).toContain("platform.sealKeys.retire[0]");
    expect(failure(["platform.sealKeys.activeKid=ABCDEF0123456789"])).toContain("platform.sealKeys.activeKid");
  });

  test("platform.authSecretPrevious mounts its Secret where platform.authSecretPreviousFile names it", () => {
    const docs = render(["platform.authSecretPrevious.existingSecret=auth-previous"]);
    const file = parseInstallation(installationOf(docs)).platform.authSecretPreviousFile;
    expect(file).toBe(`${INPUT_DIR}/auth-secret-previous/auth-secret-previous`);
    const pod = podOf(find(docs, "Job", "libredb-bootstrap"));
    const mount = pod.containers[0].volumeMounts.find((volume: { name: string }) => volume.name === "auth-secret-previous");
    expect(`${mount.mountPath}/auth-secret-previous`).toBe(file as string);
    expect(pod.volumes.find((volume: { name: string }) => volume.name === "auth-secret-previous").secret).toEqual({
      secretName: "auth-previous",
      items: [{ key: "auth-secret-previous", path: "auth-secret-previous" }],
    });
    expect(installationOf(render()).platform.authSecretPreviousFile).toBeUndefined();
  });
});

describe("the workloads", () => {
  const docs = () => render();

  test("serve gets only Platform's env Secret, and only the migrate job gets the owner's URL", () => {
    const all = docs();
    const platform = find(all, "Deployment", "libredb-platform").spec.template.spec.containers[0];
    expect(platform.args).toEqual(["serve"]);
    expect(platform.envFrom).toEqual([{ secretRef: { name: "libredb-platform-env" } }]);
    expect(platform.env).toBeUndefined();
    const migrate = all.find((doc) => doc.kind === "Job" && doc.metadata.name.startsWith("libredb-platform-migrate-"));
    expect(migrate?.spec.template.spec.containers[0].envFrom).toEqual([{ secretRef: { name: "libredb-platform-migrate-env" } }]);
    const mentions = all.filter((doc) => JSON.stringify(doc).includes("libredb-platform-migrate-env")).map((doc) => `${doc.kind}/${doc.metadata.name}`);
    expect(mentions.every((name) => name.startsWith("Job/libredb-platform-migrate-") || name === "Role/libredb-bootstrap")).toBe(true);
  });

  test("every pod runs as non-root with the RuntimeDefault seccomp profile, and only the three jobs mount a token", () => {
    for (const doc of docs()) {
      const pod = doc.kind === "Job" || doc.kind === "Deployment" || doc.kind === "StatefulSet" ? doc.spec.template.spec : undefined;
      if (pod === undefined) continue;
      const name = `${doc.kind}/${doc.metadata.name}`;
      expect(pod.securityContext?.runAsNonRoot ?? true, name).toBe(true);
      expect(pod.securityContext?.seccompProfile?.type, name).toBe("RuntimeDefault");
      const tokenJob = ["libredb-bootstrap", "libredb-restart"].includes(doc.metadata.name) || doc.metadata.name.startsWith("libredb-keycloak-configure-");
      if (!doc.metadata.name.startsWith("libredb-studio")) expect(pod.automountServiceAccountToken, name).toBe(tokenJob);
      for (const container of pod.containers) {
        expect(container.securityContext?.allowPrivilegeEscalation, `${name} ${container.name}`).toBe(false);
        expect(container.securityContext?.capabilities?.drop, `${name} ${container.name}`).toEqual(["ALL"]);
      }
    }
  });

  test("on OpenShift every pod, Studio's included, leaves its uids to the SCC; elsewhere each keeps its image's", () => {
    const uids = (all: Doc[]) =>
      all
        .filter((doc) => doc.kind === "Job" || doc.kind === "Deployment" || doc.kind === "StatefulSet")
        .map((doc) => {
          const security = doc.spec.template.spec.securityContext ?? {};
          return [`${doc.kind}/${doc.metadata.name}`, security.runAsUser, security.runAsGroup, security.fsGroup];
        });
    for (const [name, user, group, fs] of uids(docs())) {
      expect([user, group, fs].every((id) => typeof id === "number" && id > 0), String(name)).toBe(true);
    }
    for (const all of [render([], ["--api-versions", "security.openshift.io/v1"]), render(["global.compatibility.openshift.adaptSecurityContext=force"])]) {
      for (const [name, ...ids] of uids(all)) expect(ids, String(name)).toEqual([undefined, undefined, undefined]);
    }
    const disabled = render(["global.compatibility.openshift.adaptSecurityContext=disabled"], ["--api-versions", "security.openshift.io/v1"]);
    expect(find(disabled, "StatefulSet", "libredb-postgres").spec.template.spec.securityContext.runAsUser).toBe(999);
  });

  test("every pod of the amd64-only Platform image, its jobs included, runs on amd64 nodes and follows Platform's scheduling", () => {
    const platformPods = (all: Doc[]) =>
      all.filter(
        (doc) =>
          (doc.kind === "Job" || doc.kind === "Deployment") &&
          doc.spec.template.spec.containers.some((container: { image: string }) => container.image.includes("/libredb-platform:")),
      );
    const defaults = platformPods(docs());
    expect(defaults.map((doc) => doc.metadata.name.replace(/-[0-9a-f]{8}$/, "")).sort()).toEqual([
      "libredb-bootstrap",
      "libredb-keycloak-configure",
      "libredb-platform",
      "libredb-platform-migrate",
      "libredb-restart",
    ]);
    for (const doc of defaults) {
      expect(doc.spec.template.spec.nodeSelector, doc.metadata.name).toEqual({ "kubernetes.io/arch": "amd64" });
      expect(doc.spec.template.spec.tolerations, doc.metadata.name).toBeUndefined();
    }
    const placed = render(["platform.nodeSelector.pool=apps", "platform.tolerations[0].key=dedicated", "platform.tolerations[0].operator=Exists"]);
    for (const doc of platformPods(placed)) {
      expect(doc.spec.template.spec.nodeSelector, doc.metadata.name).toEqual({ "kubernetes.io/arch": "amd64", pool: "apps" });
      expect(doc.spec.template.spec.tolerations, doc.metadata.name).toEqual([{ key: "dedicated", operator: "Exists" }]);
    }
    const arm = render(["platform.nodeSelector.kubernetes\\.io/arch=arm64"]);
    expect(find(arm, "Deployment", "libredb-platform").spec.template.spec.nodeSelector).toEqual({ "kubernetes.io/arch": "arm64" });
  });

  test("Studio's environment under the chart's defaults equals the installer's renderStudioEnv", () => {
    const all = docs();
    const configMap = find(all, "ConfigMap", "libredb-studio-config").data ?? {};
    const container = find(all, "Deployment", "libredb-studio").spec.template.spec.containers[0];
    const env = new Map<string, string>(Object.entries(configMap));
    for (const entry of container.env as { name: string; value?: string }[]) if (entry.value !== undefined) env.set(entry.name, entry.value);
    const config = parseInstallation(installationOf(all));
    const expected = renderStudioEnv(computeDesired(config, manifest), {
      postgres: { host: "libredb-postgres", port: 5432 },
      secrets: { oidcClientSecret: "s", jwtSecret: "j", storageEncryptionKey: "k", databasePassword: "p" },
    });
    const secretKeys = new Set(["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "JWT_SECRET", "STORAGE_POSTGRES_URL", "GOVERNANCE_POSTGRES_URL", "STORAGE_ENCRYPTION_KEY"]);
    for (const [key, value] of Object.entries(expected)) {
      if (value === undefined || secretKeys.has(key) || key === "NO_PROXY" || key === "no_proxy") continue;
      expect(`${key}=${env.get(key)}`).toBe(`${key}=${value}`);
    }
    const fromSecret = (container.env as { name: string; valueFrom?: { secretKeyRef?: { name: string } } }[]).filter((entry) => entry.valueFrom?.secretKeyRef?.name === "libredb-studio-env").map((entry) => entry.name);
    expect(fromSecret).toEqual(expect.arrayContaining(["JWT_SECRET", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "STORAGE_POSTGRES_URL", "GOVERNANCE_POSTGRES_URL", "STORAGE_ENCRYPTION_KEY"]));
  });

  test("the managed Keycloak's environment equals the installer's compose service", () => {
    const all = docs();
    const container = find(all, "Deployment", "keycloak").spec.template.spec.containers.find((candidate: { name: string }) => candidate.name === "keycloak");
    const env = Object.fromEntries((container.env as { name: string; value: string }[]).map((entry) => [entry.name, entry.value]));
    const compose = parse(renderCompose(computeDesired(parseInstallation(installationOf(all)), manifest), composeTrust(undefined, [])));
    expect(env).toEqual(compose.services.keycloak.environment);
    expect(container.envFrom).toEqual([{ secretRef: { name: "libredb-keycloak-env" } }]);
  });

  test("the auth ingress reaches only the edge, and the Admin API stays in-cluster", () => {
    const ingress = find(docs(), "Ingress", "keycloak");
    expect(ingress.spec.rules[0].http.paths[0].backend.service.name).toBe("keycloak-edge");
  });

  test("Platform's Ingress asks ingress-nginx for a 16k header buffer, which Platform's sign-in callback needs", () => {
    const annotation = "nginx.ingress.kubernetes.io/proxy-buffer-size";
    expect(find(docs(), "Ingress", "libredb-platform").metadata.annotations?.[annotation]).toBe("16k");
    expect(find(render(["ingress.annotations.team=dba"]), "Ingress", "libredb-platform").metadata.annotations).toEqual({ [annotation]: "16k", team: "dba" });
  });

  test("a job's name follows the revision and what it runs: the same values keep it, a new installation document renames it", () => {
    const names = (sets: string[]) => render(sets).filter((doc) => doc.kind === "Job").map((doc) => doc.metadata.name).sort();
    expect(names([])).toEqual(names([]));
    const changed = names(["platform.organizationName=Other"]);
    expect(changed.filter((name) => names([]).includes(name))).toEqual(["libredb-bootstrap", "libredb-restart"]);
  });

  test("the uploads volume outlives helm uninstall, as the database's volume claims do by Kubernetes' rule", () => {
    const all = docs();
    expect(find(all, "PersistentVolumeClaim", "libredb-platform-uploads").metadata.annotations?.["helm.sh/resource-policy"]).toBe("keep");
    expect(find(all, "StatefulSet", "libredb-postgres").spec.volumeClaimTemplates[0].metadata.annotations).toBeUndefined();
    const off = render(["platform.persistence.enabled=false"]);
    expect(off.some((doc) => doc.kind === "PersistentVolumeClaim")).toBe(false);
  });

  test("network policies guard PostgreSQL and Keycloak's Admin API by default, and render nothing when disabled", () => {
    expect(docs().filter((doc) => doc.kind === "NetworkPolicy").map((doc) => doc.metadata.name).sort()).toEqual(["keycloak", "libredb-postgres"]);
    expect(render(["networkPolicy.enabled=false"]).some((doc) => doc.kind === "NetworkPolicy")).toBe(false);
  });

  test("the jobs after the hook are Argo CD sync hooks, so a sync runs them again as an upgrade does", () => {
    for (const job of docs().filter((doc) => doc.kind === "Job" && doc.metadata.name !== "libredb-bootstrap" && !doc.metadata.annotations?.["helm.sh/hook"])) {
      expect(job.metadata.annotations?.["argocd.argoproj.io/hook"], job.metadata.name).toBe("Sync");
      expect(job.metadata.annotations?.["argocd.argoproj.io/hook-delete-policy"], job.metadata.name).toBe("BeforeHookCreation");
    }
  });

  test("the bootstrap and keycloak jobs fail at once on a refusal a retry cannot change", () => {
    for (const job of docs().filter((doc) => doc.kind === "Job" && (doc.metadata.name === "libredb-bootstrap" || doc.metadata.name.startsWith("libredb-keycloak-configure-")))) {
      const rule = job.spec.podFailurePolicy.rules[0];
      expect(rule.action, job.metadata.name).toBe("FailJob");
      expect(rule.onExitCodes.values).toEqual([2, 3, 6]);
      expect(rule.onExitCodes.containerName).toBe(job.spec.template.spec.containers[0].name);
    }
  });

  test("the bootstrap also runs before a rollback, where it refuses an older release, and the restart job after each change", () => {
    const all = docs();
    expect(find(all, "Job", "libredb-bootstrap").metadata.annotations?.["helm.sh/hook"]).toBe("pre-install,pre-upgrade,pre-rollback");
    const restart = find(all, "Job", "libredb-restart");
    expect(restart.metadata.annotations?.["helm.sh/hook"]).toBe("post-install,post-upgrade,post-rollback");
    expect(restart.spec.template.spec.serviceAccountName).toBe("libredb-restart");
  });

  test("the restart Role may patch exactly the workloads the bootstrap job asks to restart", () => {
    const role = find(docs(), "Role", "libredb-restart");
    const names = (resource: string) => role.rules?.find((rule) => rule.resources[0] === resource)?.resourceNames ?? [];
    const expected = Object.values(WORKLOADS);
    expect([...names("deployments")].sort()).toEqual(expected.filter((w) => w.kind === "deployments").map((w) => w.name).sort());
    expect(names("statefulsets")).toEqual(expected.filter((w) => w.kind === "statefulsets").map((w) => w.name));
    const studio = find(docs(), "Deployment", WORKLOADS.studio.name);
    expect(studio.metadata.name).toBe(WORKLOADS.studio.name);
  });

  test("the objects the jobs write carry the installation's label and no Helm or Argo CD tracking label", () => {
    const settings = JSON.parse(find(docs(), "ConfigMap", "libredb-bootstrap-chart").data?.["chart.json"] as string);
    expect(settings.labels["install.libredb.org/installation"]).toBe("libredb");
    expect(settings.labels["app.kubernetes.io/instance"]).toBeUndefined();
  });

  test("the migrate job's wait passes the password in PGPASSWORD, never on a command line", () => {
    const migrate = docs().find((doc) => doc.kind === "Job" && doc.metadata.name.startsWith("libredb-platform-migrate-"));
    const script = migrate?.spec.template.spec.initContainers[0].command.join("\n") as string;
    expect(script).toContain('export PGPASSWORD="${rest%%@*}"');
    expect(script).not.toContain('psql "$url"');
  });
});

describe("the bootstrap Role", () => {
  async function written(sets: string[], inputs: Record<string, string> = {}) {
    const all = render(sets);
    const config = parseInstallation(installationOf(all));
    const objects = new MemoryObjects();
    await runBootstrap(
      { config, manifest, studioSecretName: "libredb-studio-env", jobsBundle: new Uint8Array([1]) },
      { objects, readFile: files(inputs), env: {}, now: () => new Date(), log: () => {}, redactor: new Redactor() },
    );
    const role = find(all, "Role", "libredb-bootstrap");
    const allowed = (resource: string) => new Set<string>(role.rules?.find((rule) => rule.resources.length === 1 && rule.resources[0] === resource)?.resourceNames ?? []);
    return { objects, secrets: allowed("secrets"), configMaps: allowed("configmaps") };
  }

  test.each([
    ["managed PostgreSQL and Keycloak", [] as string[]],
    ["the site's TLS Secrets", ["tls.mode=secrets", "tls.secrets.platform=a", "tls.secrets.studio=b", "tls.secrets.auth=c", "tls.caBundle=PEM", "studio.ingress.tls[0].secretName=b"]],
  ])("with %s may replace exactly the objects the job writes", async (_name, sets) => {
    const ca = (await createCa({ commonName: "site", now: new Date() })).certPem;
    const { objects, secrets, configMaps } = await written(
      sets.map((set) => (set === "tls.caBundle=PEM" ? `tls.caBundle=${ca.replaceAll(",", "\\,")}` : set)),
      { [`${INPUT_DIR}/ca/tls-ca.crt`]: ca },
    );
    expect([...objects.secrets.keys()].sort()).toEqual([...secrets].sort());
    expect([...objects.configMaps.keys()].sort()).toEqual([...configMaps].sort());
  });

  test("with an external PostgreSQL and the site's Keycloak may replace exactly the objects the job writes", async () => {
    const ca = (await createCa({ commonName: "pg", now: new Date() })).certPem;
    const { objects, secrets, configMaps } = await written(
      ["postgresql.mode=external", "postgresql.external.host=pg.corp.example", "postgresql.external.caBundle=PEM", "keycloak.mode=external", "keycloak.external.baseUrl=https://auth.libredb.test", "keycloak.external.provisioning=manual", "keycloak.external.clientSecretsSecret=kc"],
      {
        [`${INPUT_DIR}/ca/postgres-ca.crt`]: ca,
        [`${INPUT_DIR}/keycloak-clients/studio-client-secret`]: "s",
        [`${INPUT_DIR}/keycloak-clients/platform-client-secret`]: "p",
      },
    );
    expect([...objects.secrets.keys()].sort()).toEqual([...secrets].sort());
    expect([...objects.configMaps.keys()].sort()).toEqual([...configMaps].sort());
  });
});
