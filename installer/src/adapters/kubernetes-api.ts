// The Kubernetes API of the chart's jobs: the namespace's Secrets and ConfigMaps through the in-cluster service
// account. The job's container trusts the cluster CA through NODE_EXTRA_CA_CERTS, so plain fetch reaches the API
// server. A replace carries the resourceVersion the job read, so two jobs never overwrite each other's write, and
// keeps the labels and annotations others gave the object. Every object the jobs write is marked so that neither
// Helm nor Argo CD prunes it: it holds the installation's secrets, which must outlive the release.
import type { KubernetesObjects, ObjectData } from "../kubernetes/bootstrap";
import type { Workload } from "../kubernetes/names";

/** Argo CD keeps an object with these annotations through a prune and leaves it out of the app's sync status. */
export const KEEP_ANNOTATIONS = {
  "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
  "argocd.argoproj.io/compare-options": "IgnoreExtraneous",
} as const;

/** The label by which Helm-aware tools track an object as part of a release; the jobs' objects never carry it. */
export const TRACKING_LABEL = "app.kubernetes.io/instance";

/** The pod template annotation a restart sets, as `kubectl rollout restart` does with its own. */
export const RESTARTED_AT = "install.libredb.org/restarted-at";

const TIMEOUT_MS = 30_000;

/** The files every pod with a service account token reads. */
export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export class KubernetesApiError extends Error {
  constructor(method: string, path: string, status: number, reason: string) {
    super(`Kubernetes API ${method} ${path} answered ${status}${reason === "" ? "" : `: ${reason}`}`);
    this.name = "KubernetesApiError";
  }
}

export interface KubernetesApiOptions {
  /** https://<host>:<port> of the API server. */
  server: string;
  token: string;
  namespace: string;
  /** The labels every object the job writes carries. */
  labels: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

interface ObjectMeta {
  name: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

function encode(data: ObjectData): Record<string, string> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value, "utf8").toString("base64")]));
}

function decode(data: Record<string, string> | undefined): ObjectData {
  return Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [key, Buffer.from(value, "base64").toString("utf8")]));
}

async function reasonOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : "";
  } catch {
    return "";
  }
}

export class KubernetesApi implements KubernetesObjects {
  readonly #options: KubernetesApiOptions;
  readonly #versions = new Map<string, string>();
  readonly #metadata = new Map<string, ObjectMeta>();
  readonly #types = new Map<string, string>();

  constructor(options: KubernetesApiOptions) {
    this.#options = options;
  }

  /** The API of the pod's own service account, from the standard environment and files. */
  static inCluster(
    env: Readonly<Record<string, string | undefined>>,
    readFile: (path: string) => string | undefined,
    labels: Readonly<Record<string, string>>,
    log?: (line: string) => void,
  ): KubernetesApi {
    const host = env.KUBERNETES_SERVICE_HOST;
    const port = env.KUBERNETES_SERVICE_PORT ?? "443";
    const token = readFile(`${SERVICE_ACCOUNT_DIR}/token`)?.trim();
    const namespace = readFile(`${SERVICE_ACCOUNT_DIR}/namespace`)?.trim();
    if (host === undefined || token === undefined || namespace === undefined) {
      throw new Error("not running in a Kubernetes pod with a service account token: KUBERNETES_SERVICE_HOST or the token is missing");
    }
    const server = host.includes(":") ? `https://[${host}]:${port}` : `https://${host}:${port}`;
    return new KubernetesApi({ server, token, namespace, labels, ...(log === undefined ? {} : { log }) });
  }

  get namespace(): string {
    return this.#options.namespace;
  }

  async #request(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<Response> {
    const response = await (this.#options.fetch ?? fetch)(`${this.#options.server}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#options.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": contentType }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    this.#options.log?.(`kubernetes ${method} ${path} ${response.status}`);
    return response;
  }

  #path(kind: "secrets" | "configmaps", name?: string): string {
    const base = `/api/v1/namespaces/${encodeURIComponent(this.#options.namespace)}/${kind}`;
    return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
  }

  async #get(
    kind: "secrets" | "configmaps",
    name: string,
  ): Promise<{ metadata: ObjectMeta; data?: Record<string, string>; type?: string } | undefined> {
    const path = this.#path(kind, name);
    const response = await this.#request("GET", path);
    if (response.status === 404) {
      await response.body?.cancel();
      this.#versions.delete(`${kind}/${name}`);
      return undefined;
    }
    if (!response.ok) throw new KubernetesApiError("GET", path, response.status, await reasonOf(response));
    const object = (await response.json()) as { metadata: ObjectMeta; data?: Record<string, string>; type?: string };
    if (object.metadata.resourceVersion !== undefined) this.#versions.set(`${kind}/${name}`, object.metadata.resourceVersion);
    this.#metadata.set(`${kind}/${name}`, object.metadata);
    if (object.type !== undefined) this.#types.set(`${kind}/${name}`, object.type);
    return object;
  }

  async #put(kind: "secrets" | "configmaps", name: string, body: Record<string, unknown>): Promise<void> {
    const key = `${kind}/${name}`;
    if (!this.#versions.has(key)) await this.#get(kind, name);
    const version = this.#versions.get(key);
    const existingType = this.#types.get(key);
    if (version !== undefined && body.type !== undefined && existingType !== undefined && existingType !== body.type) {
      throw new KubernetesApiError(
        "PUT",
        this.#path(kind, name),
        422,
        `Secret ${name} exists with type ${existingType}, not ${String(body.type)}; it is in the way of the installation, so delete or rename it`,
      );
    }
    const previous = this.#metadata.get(key);
    // An object an earlier build wrote may carry Helm's instance label, which a tracking tool would prune by.
    const { [TRACKING_LABEL]: _tracking, ...kept } = previous?.labels ?? {};
    const metadata: ObjectMeta = {
      name,
      labels: { ...kept, ...this.#options.labels },
      annotations: { ...previous?.annotations, ...KEEP_ANNOTATIONS },
    };
    const object = { ...body, metadata: version === undefined ? metadata : { ...metadata, resourceVersion: version } };
    const path = version === undefined ? this.#path(kind) : this.#path(kind, name);
    const method = version === undefined ? "POST" : "PUT";
    const response = await this.#request(method, path, object);
    if (!response.ok) throw new KubernetesApiError(method, path, response.status, await reasonOf(response));
    const written = (await response.json()) as { metadata: ObjectMeta; type?: string };
    if (written.metadata.resourceVersion !== undefined) this.#versions.set(key, written.metadata.resourceVersion);
    this.#metadata.set(key, written.metadata);
    if (written.type !== undefined) this.#types.set(key, written.type);
  }

  async getSecret(name: string): Promise<ObjectData | undefined> {
    const object = await this.#get("secrets", name);
    return object === undefined ? undefined : decode(object.data);
  }

  async getConfigMap(name: string): Promise<ObjectData | undefined> {
    return (await this.#get("configmaps", name))?.data;
  }

  async restart(workload: Workload, at: Date): Promise<"restarted" | "absent"> {
    const path = `/apis/apps/v1/namespaces/${encodeURIComponent(this.#options.namespace)}/${workload.kind}/${encodeURIComponent(workload.name)}`;
    const patch = { spec: { template: { metadata: { annotations: { [RESTARTED_AT]: at.toISOString() } } } } };
    const response = await this.#request("PATCH", path, patch, "application/merge-patch+json");
    if (response.status === 404) {
      await response.body?.cancel();
      return "absent";
    }
    if (!response.ok) throw new KubernetesApiError("PATCH", path, response.status, await reasonOf(response));
    await response.body?.cancel();
    return "restarted";
  }

  async podsCreated(workload: Workload): Promise<Date[] | undefined> {
    const namespace = encodeURIComponent(this.#options.namespace);
    const path = `/apis/apps/v1/namespaces/${namespace}/${workload.kind}/${encodeURIComponent(workload.name)}`;
    const response = await this.#request("GET", path);
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) throw new KubernetesApiError("GET", path, response.status, await reasonOf(response));
    const object = (await response.json()) as { spec: { selector: { matchLabels: Record<string, string> } } };
    const selector = Object.entries(object.spec.selector.matchLabels).map(([key, value]) => `${key}=${value}`).join(",");
    const podsPath = `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(selector)}`;
    const pods = await this.#request("GET", podsPath);
    if (!pods.ok) throw new KubernetesApiError("GET", podsPath, pods.status, await reasonOf(pods));
    const list = (await pods.json()) as { items: { metadata: { creationTimestamp: string } }[] };
    return list.items.map((pod) => new Date(pod.metadata.creationTimestamp));
  }

  async putSecret(name: string, data: ObjectData, type: "Opaque" | "kubernetes.io/tls" = "Opaque"): Promise<void> {
    await this.#put("secrets", name, { apiVersion: "v1", kind: "Secret", type, data: encode(data) });
  }

  async putConfigMap(name: string, data: ObjectData, binaryData?: Readonly<Record<string, Uint8Array>>): Promise<void> {
    const binary =
      binaryData === undefined
        ? {}
        : { binaryData: Object.fromEntries(Object.entries(binaryData).map(([key, value]) => [key, Buffer.from(value).toString("base64")])) };
    await this.#put("configmaps", name, { apiVersion: "v1", kind: "ConfigMap", data, ...binary });
  }
}
