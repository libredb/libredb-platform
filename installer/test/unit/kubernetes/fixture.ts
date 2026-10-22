// Fixtures of the Helm chart's jobs: installations of mode kubernetes as the chart renders them, an in-memory
// namespace, and the input files the chart mounts.
import { parseInstallation, type LibreDBInstallation } from "../../../src/config/schema";
import type { KubernetesObjects, ObjectData } from "../../../src/kubernetes/bootstrap";
import { INPUT_DIR, type Workload } from "../../../src/kubernetes/names";
import { Redactor } from "../../../src/log/redact";

export const LICENSE = "ldl1.0123456789abcdef.eyJpZCI6IlRFU1QifQ.c2lnbmF0dXJl";

export const HOSTS = { platform: "platform.libredb.test", studio: "studio.libredb.test", auth: "auth.libredb.test" };

/** The installation document of the chart's default values, with optional overrides of whole sections. */
export function installation(overrides: Record<string, unknown> = {}): LibreDBInstallation {
  return parseInstallation({
    apiVersion: "install.libredb.org/v1",
    kind: "LibreDBInstallation",
    metadata: { name: "libredb" },
    mode: "kubernetes",
    endpoints: { style: "hostnames", hosts: HOSTS },
    tls: { mode: "generated" },
    postgres: { mode: "managed" },
    keycloak: { mode: "managed", realm: "libredb" },
    platform: { organizationName: "Acme", licenseFile: `${INPUT_DIR}/license/license` },
    kubernetes: { namespace: "libredb" },
    ...overrides,
  });
}

export const EXTERNAL_POSTGRES = {
  postgres: { mode: "external", external: { host: "pg.corp.example", port: 5432, provisioning: "manual", caBundleFile: `${INPUT_DIR}/ca/postgres-ca.crt` } },
};

export const MANUAL_KEYCLOAK = {
  keycloak: {
    mode: "external",
    realm: "corp",
    external: {
      baseUrl: "https://auth.libredb.test",
      provisioning: "manual",
      studioClientSecretFile: `${INPUT_DIR}/keycloak-clients/studio-client-secret`,
      platformClientSecretFile: `${INPUT_DIR}/keycloak-clients/platform-client-secret`,
    },
  },
};

export const INSTALLER_KEYCLOAK = {
  keycloak: {
    mode: "external",
    realm: "corp",
    external: {
      baseUrl: "https://auth.libredb.test",
      adminUrl: "https://kc-admin.corp.example",
      provisioning: "installer",
      adminRealm: "master",
      adminClientId: "corp-admin",
      adminClientSecretFile: `${INPUT_DIR}/keycloak-admin/admin-client-secret`,
    },
  },
};

/** A namespace's Secrets and ConfigMaps in memory, with every write recorded. */
export class MemoryObjects implements KubernetesObjects {
  readonly secrets = new Map<string, { data: ObjectData; type: string }>();
  readonly configMaps = new Map<string, ObjectData>();
  readonly binaryData = new Map<string, Readonly<Record<string, Uint8Array>>>();
  readonly writes: string[] = [];
  readonly restarts: string[] = [];
  /** The workloads that exist, which a restart finds. */
  readonly workloads = new Set<string>();

  async getConfigMap(name: string): Promise<ObjectData | undefined> {
    const data = this.configMaps.get(name);
    return data === undefined ? undefined : { ...data };
  }

  /** Pod creation times per workload; a workload in `workloads` without an entry has one pod from long ago. */
  readonly pods = new Map<string, Date[]>();

  async podsCreated(workload: Workload): Promise<Date[] | undefined> {
    const key = `${workload.kind}/${workload.name}`;
    if (!this.workloads.has(key)) return undefined;
    return this.pods.get(key) ?? [new Date("2000-01-01T00:00:00Z")];
  }

  async restart(workload: Workload): Promise<"restarted" | "absent"> {
    const key = `${workload.kind}/${workload.name}`;
    if (!this.workloads.has(key)) return "absent";
    this.restarts.push(key);
    return "restarted";
  }

  async getSecret(name: string): Promise<ObjectData | undefined> {
    const secret = this.secrets.get(name);
    return secret === undefined ? undefined : { ...secret.data };
  }

  async putSecret(name: string, data: ObjectData, type: "Opaque" | "kubernetes.io/tls" = "Opaque"): Promise<void> {
    this.secrets.set(name, { data: { ...data }, type });
    this.writes.push(`secret/${name}`);
  }

  async putConfigMap(name: string, data: ObjectData, binaryData?: Readonly<Record<string, Uint8Array>>): Promise<void> {
    this.configMaps.set(name, { ...data });
    if (binaryData !== undefined) this.binaryData.set(name, binaryData);
    this.writes.push(`configmap/${name}`);
  }

  secret(name: string): ObjectData {
    const secret = this.secrets.get(name);
    if (secret === undefined) throw new Error(`no Secret ${name}`);
    return secret.data;
  }
}

/** The input files the chart mounts, by path. */
export function files(entries: Record<string, string> = {}): (path: string) => string | undefined {
  const all: Record<string, string> = { [`${INPUT_DIR}/license/license`]: `${LICENSE}\n`, ...entries };
  return (path) => all[path];
}

export function io(objects: MemoryObjects, readFile = files(), now = new Date("2026-10-20T00:00:00Z")) {
  const lines: string[] = [];
  return {
    io: { objects, readFile, env: {}, now: () => now, log: (line: string) => lines.push(line), redactor: new Redactor() },
    lines,
  };
}
