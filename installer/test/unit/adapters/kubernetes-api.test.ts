import { describe, expect, test } from "bun:test";
import { KEEP_ANNOTATIONS, KubernetesApi, KubernetesApiError, RESTARTED_AT, SERVICE_ACCOUNT_DIR } from "../../../src/adapters/kubernetes-api";

interface Call {
  method: string;
  url: string;
  body?: {
    metadata: { name: string; resourceVersion?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
    data?: Record<string, string>;
    type?: string;
  };
}

/** An API server with one namespace's Secrets, answering as kube-apiserver does. */
function apiServer(initial: Record<string, { data: Record<string, string>; version: string; type?: string; labels?: Record<string, string> }> = {}) {
  const objects = new Map(Object.entries(initial));
  const calls: Call[] = [];
  let version = 100;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Call["body"]);
    calls.push({ method, url, ...(body === undefined ? {} : { body }) });
    const name = url.split("/").pop() as string;
    if (method === "GET") {
      const found = objects.get(name);
      if (found === undefined) return Response.json({ message: "not found" }, { status: 404 });
      return Response.json({ metadata: { name, resourceVersion: found.version, labels: found.labels }, data: found.data, type: found.type });
    }
    const target = body?.metadata.name as string;
    if (method === "PUT" && objects.get(target)?.version !== body?.metadata.resourceVersion) {
      return Response.json({ message: "the object has been modified" }, { status: 409 });
    }
    version += 1;
    objects.set(target, { data: body?.data ?? {}, version: String(version) });
    return Response.json({ metadata: { name: target, resourceVersion: String(version) } }, { status: method === "POST" ? 201 : 200 });
  }) as typeof fetch;
  return { fetcher, calls, objects };
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

function api(fetcher: typeof fetch) {
  return new KubernetesApi({ server: "https://10.0.0.1:443", token: "t", namespace: "libredb", labels: { "app.kubernetes.io/part-of": "libredb" }, fetch: fetcher });
}

describe("KubernetesApi", () => {
  test("reads a Secret decoded, and undefined for a missing one", async () => {
    const server = apiServer({ present: { data: { key: b64("value") }, version: "7" } });
    const kube = api(server.fetcher);
    expect(await kube.getSecret("present")).toEqual({ key: "value" });
    expect(await kube.getSecret("missing")).toBeUndefined();
    expect(server.calls[0]?.url).toBe("https://10.0.0.1:443/api/v1/namespaces/libredb/secrets/present");
  });

  test("creates a missing Secret with the job's labels, and replaces it with the version it read", async () => {
    const server = apiServer();
    const kube = api(server.fetcher);
    await kube.putSecret("store", { a: "1" });
    await kube.putSecret("store", { a: "2" }, "Opaque");
    const writes = server.calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.method)).toEqual(["POST", "PUT"]);
    expect(writes[0]?.body?.metadata).toEqual({ name: "store", labels: { "app.kubernetes.io/part-of": "libredb" }, annotations: { ...KEEP_ANNOTATIONS } });
    expect(writes[1]?.body?.metadata.resourceVersion).toBe("101");
    expect(Buffer.from(server.objects.get("store")?.data.a as string, "base64").toString()).toBe("2");
  });

  test("a replace after another writer changed the object fails instead of overwriting it", async () => {
    const server = apiServer({ store: { data: {}, version: "1" } });
    const kube = api(server.fetcher);
    await kube.getSecret("store");
    server.objects.set("store", { data: {}, version: "2" });
    await expect(kube.putSecret("store", { a: "1" })).rejects.toThrow(KubernetesApiError);
  });

  test("writes a ConfigMap's data as plain text", async () => {
    const server = apiServer();
    await api(server.fetcher).putConfigMap("libredb-ca", { "ca.crt": "pem" });
    const write = server.calls.find((call) => call.method === "POST");
    expect(write?.url).toBe("https://10.0.0.1:443/api/v1/namespaces/libredb/configmaps");
    expect(write?.body?.data).toEqual({ "ca.crt": "pem" });
  });

  test("a failed read names the status and the server's reason", async () => {
    const fetcher = (async () => Response.json({ message: "forbidden by RBAC" }, { status: 403 })) as unknown as typeof fetch;
    await expect(api(fetcher).getSecret("x")).rejects.toThrow("answered 403: forbidden by RBAC");
  });

  test("inCluster reads the service account and the API server's address", () => {
    const files: Record<string, string> = { [`${SERVICE_ACCOUNT_DIR}/token`]: "tok\n", [`${SERVICE_ACCOUNT_DIR}/namespace`]: "libredb\n" };
    const kube = KubernetesApi.inCluster({ KUBERNETES_SERVICE_HOST: "fd00::1", KUBERNETES_SERVICE_PORT: "6443" }, (path) => files[path], {});
    expect(kube.namespace).toBe("libredb");
    expect(() => KubernetesApi.inCluster({}, () => undefined, {})).toThrow("not running in a Kubernetes pod");
  });
});

describe("KubernetesApi beyond Secrets", () => {
  test("a replace keeps the labels others gave the object, except Helm's tracking label", async () => {
    const server = apiServer({ store: { data: {}, version: "3", labels: { team: "db", "app.kubernetes.io/instance": "libredb" } } });
    await api(server.fetcher).putSecret("store", { a: "1" });
    const put = server.calls.find((call) => call.method === "PUT");
    expect(put?.body?.metadata.labels).toEqual({ team: "db", "app.kubernetes.io/part-of": "libredb" });
  });

  test("a Secret of another type in the way fails naming it instead of a bare 422", async () => {
    const server = apiServer({ "libredb-tls-platform": { data: {}, version: "1", type: "Opaque" } });
    await expect(api(server.fetcher).putSecret("libredb-tls-platform", { a: "1" }, "kubernetes.io/tls")).rejects.toThrow(
      "exists with type Opaque, not kubernetes.io/tls",
    );
  });

  test("reads a ConfigMap's data, and undefined for a missing one", async () => {
    const fetcher = (async (input: string | URL | Request) =>
      String(input).endsWith("/present") ? Response.json({ metadata: { name: "present" }, data: { k: "v" } }) : Response.json({}, { status: 404 })) as unknown as typeof fetch;
    expect(await api(fetcher).getConfigMap("present")).toEqual({ k: "v" });
    expect(await api(fetcher).getConfigMap("missing")).toBeUndefined();
  });

  test("restarts a workload with a merge patch of its pod template, and reports one that does not exist", async () => {
    const calls: { url: string; method?: string; type?: string | null; body?: string }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, type: new Headers(init?.headers).get("content-type"), body: String(init?.body) });
      return String(input).includes("/statefulsets/") ? Response.json({}, { status: 404 }) : Response.json({});
    }) as unknown as typeof fetch;
    const at = new Date("2026-10-20T00:00:00Z");
    expect(await api(fetcher).restart({ kind: "deployments", name: "libredb-platform" }, at)).toBe("restarted");
    expect(await api(fetcher).restart({ kind: "statefulsets", name: "libredb-postgres" }, at)).toBe("absent");
    expect(calls[0]).toEqual({
      url: "https://10.0.0.1:443/apis/apps/v1/namespaces/libredb/deployments/libredb-platform",
      method: "PATCH",
      type: "application/merge-patch+json",
      body: JSON.stringify({ spec: { template: { metadata: { annotations: { [RESTARTED_AT]: at.toISOString() } } } } }),
    });
    const refused = (async () => Response.json({ message: "forbidden" }, { status: 403 })) as unknown as typeof fetch;
    await expect(api(refused).restart({ kind: "deployments", name: "keycloak" }, at)).rejects.toThrow("answered 403: forbidden");
  });
});

describe("KubernetesApi.podsCreated", () => {
  test("lists the creation times of a workload's pods by its selector, and undefined for a missing workload", async () => {
    const urls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/deployments/keycloak")) return Response.json({}, { status: 404 });
      if (url.includes("/deployments/")) return Response.json({ spec: { selector: { matchLabels: { app: "platform", tier: "web" } } } });
      return Response.json({ items: [{ metadata: { creationTimestamp: "2026-10-20T00:00:00Z" } }] });
    }) as unknown as typeof fetch;
    const created = await api(fetcher).podsCreated({ kind: "deployments", name: "libredb-platform" });
    expect(created).toEqual([new Date("2026-10-20T00:00:00Z")]);
    expect(urls[1]).toBe("https://10.0.0.1:443/api/v1/namespaces/libredb/pods?labelSelector=app%3Dplatform%2Ctier%3Dweb");
    expect(await api(fetcher).podsCreated({ kind: "deployments", name: "keycloak" })).toBeUndefined();
  });

  test("a refused read names the status", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return calls === 1 ? Response.json({ message: "no" }, { status: 403 }) : Response.json({});
    }) as unknown as typeof fetch;
    await expect(api(fetcher).podsCreated({ kind: "deployments", name: "libredb-studio" })).rejects.toThrow("answered 403");
    const pods = (async (input: string | URL | Request) =>
      String(input).includes("/pods") ? Response.json({ message: "no pods" }, { status: 403 }) : Response.json({ spec: { selector: { matchLabels: { a: "b" } } } })) as unknown as typeof fetch;
    await expect(api(pods).podsCreated({ kind: "deployments", name: "libredb-studio" })).rejects.toThrow("no pods");
  });
});
