import { describe, expect, test } from "bun:test";
import { CLIENT_SECRET_NAMES } from "../../../src/keycloak/desired";
import { MANAGED_ATTRIBUTE } from "../../../src/keycloak/representations";
import {
  adminTarget,
  ensureManagedRealm,
  KEYCLOAK_CONFIG_DIR,
  MANAGED_KEYCLOAK_URL,
  runKeycloakJob,
  waitForKeycloak,
  type ConvergeFunctions,
  type ConvergeTarget,
} from "../../../src/kubernetes/keycloak";
import { INPUT_DIR, K8S_NAMES, STORE_KEYS } from "../../../src/kubernetes/names";
import { Redactor } from "../../../src/log/redact";
import { STATE_KEY } from "../../../src/kubernetes/bootstrap";
import type { InstallerState } from "../../../src/state/store";
import { observedFixture } from "../keycloak/fixture";
import { manifestFixture } from "../release/fixture";
import { installation, INSTALLER_KEYCLOAK, MANUAL_KEYCLOAK, MemoryObjects } from "./fixture";

const CONFIG: Record<string, string> = {
  [`${KEYCLOAK_CONFIG_DIR}/${STORE_KEYS.keycloakBootstrapSecret}`]: "bootstrap-secret",
  [`${KEYCLOAK_CONFIG_DIR}/${CLIENT_SECRET_NAMES.studio}`]: "studio-secret",
  [`${KEYCLOAK_CONFIG_DIR}/${CLIENT_SECRET_NAMES.platform}`]: "platform-secret",
  [`${KEYCLOAK_CONFIG_DIR}/${STORE_KEYS.firstAdminPassword}`]: "first-admin-temporary",
  [`${KEYCLOAK_CONFIG_DIR}/${STORE_KEYS.userManagerPassword}`]: "user-manager-temporary",
  [`${INPUT_DIR}/keycloak-admin/admin-client-secret`]: "corp-admin-secret\n",
};

const readFile = (path: string) => CONFIG[path];

/** A Keycloak that answers the token request and the realm lookup, and records every request. */
function keycloak(realm: "missing" | "managed" | "foreign") {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (url.endsWith("/protocol/openid-connect/token")) return Response.json({ access_token: "token" });
    if (method === "GET" && url.endsWith("/admin/realms/libredb")) {
      if (realm === "missing") return new Response("", { status: 404 });
      return Response.json({ attributes: realm === "managed" ? { [MANAGED_ATTRIBUTE]: "true" } : {} });
    }
    if (method === "POST" && url.endsWith("/admin/realms")) return new Response("", { status: 201 });
    return new Response("", { status: 500 });
  }) as typeof fetch;
  return { fetcher, requests };
}

function jobIO(objects: MemoryObjects, fetcher?: typeof fetch) {
  const written = new Map<string, string>();
  const lines: string[] = [];
  return {
    io: {
      objects,
      readFile,
      writeFile: (path: string, content: string) => written.set(path, content),
      env: {},
      tmpDir: "/tmp",
      owner: { uid: 1001, gid: 1001 },
      log: (line: string) => lines.push(line),
      redactor: new Redactor(),
      ...(fetcher === undefined ? {} : { fetch: fetcher }),
    },
    written,
    lines,
  };
}

function converge() {
  const seen: { target?: ConvergeTarget; applied?: number } = {};
  const functions: ConvergeFunctions = {
    observe: async (target) => {
      seen.target = target;
      return { ...observedFixture("empty-realm"), realm: target.realm };
    },
    apply: async (planned, _target, state: InstallerState) => {
      seen.applied = planned.length;
      state.ownership.push({ kind: "keycloak-user", name: "libredb-admin", step: "keycloak-configure" });
    },
  };
  return { functions, seen };
}

describe("the keycloak-configure job", () => {
  test("creates a managed realm, writes the temporary passwords for the step and records the accounts in the state", async () => {
    const objects = new MemoryObjects();
    const { fetcher, requests } = keycloak("missing");
    const run = jobIO(objects, fetcher);
    const step = converge();
    await runKeycloakJob(installation(), manifestFixture(), run.io, step.functions);
    expect(requests).toContain(`POST ${MANAGED_KEYCLOAK_URL}/admin/realms`);
    expect(run.written.get("/tmp/first-admin.txt")).toBe("first-admin-temporary\n");
    expect(run.written.get("/tmp/user-manager.txt")).toBe("user-manager-temporary\n");
    expect(step.seen.target?.baseUrl).toBe(MANAGED_KEYCLOAK_URL);
    expect(step.seen.target?.credentials).toEqual({ realm: "master", clientId: "libredb-bootstrap", clientSecret: "bootstrap-secret" });
    expect(step.seen.target?.desired.appClients.map((client) => client.representation.secret)).toEqual(["studio-secret", "platform-secret"]);
    expect(step.seen.applied).toBe(15);
    expect(run.lines).toContain("keycloak: realm libredb created");
    expect(run.lines.at(-1)).toBe("keycloak: applied 15 actions");
    const state = JSON.parse(objects.secret(K8S_NAMES.state)[STATE_KEY] as string) as InstallerState;
    expect(state.ownership).toEqual([{ kind: "keycloak-user", name: "libredb-admin", step: "keycloak-configure" }]);
  });

  test("keeps a managed realm the chart created, and refuses one it did not", async () => {
    const managed = keycloak("managed");
    const run = jobIO(new MemoryObjects(), managed.fetcher);
    await runKeycloakJob(installation(), manifestFixture(), run.io, converge().functions);
    expect(run.lines).toContain("keycloak: realm libredb exists");
    expect(managed.requests.some((request) => request.startsWith("POST") && request.endsWith("/admin/realms"))).toBe(false);
    const foreign = keycloak("foreign");
    await expect(runKeycloakJob(installation(), manifestFixture(), jobIO(new MemoryObjects(), foreign.fetcher).io, converge().functions)).rejects.toThrow(
      MANAGED_ATTRIBUTE,
    );
  });

  test("an external Keycloak with provisioning installer converges with the site's admin credential and no realm creation", async () => {
    const run = jobIO(new MemoryObjects(), (async () => new Response("", { status: 200 })) as unknown as typeof fetch);
    const step = converge();
    await runKeycloakJob(installation(INSTALLER_KEYCLOAK), manifestFixture(), run.io, step.functions);
    expect(step.seen.target?.baseUrl).toBe("https://kc-admin.corp.example");
    expect(step.seen.target?.credentials).toEqual({ realm: "master", clientId: "corp-admin", clientSecret: "corp-admin-secret" });
    expect(run.written.size).toBe(0);
    expect(step.seen.applied).toBeGreaterThan(0);
    expect(run.lines.at(-1)).toBe(`keycloak: applied ${step.seen.applied} actions`);
  });
});

describe("the keycloak-configure job with mobile.enabled", () => {
  test("converges the public client libredb-mobile with PKCE S256 and both audience mappers, as the installer does", async () => {
    const step = converge();
    await runKeycloakJob(installation({ mobile: { enabled: true } }), manifestFixture(), jobIO(new MemoryObjects(), keycloak("managed").fetcher).io, step.functions);
    const mobile = step.seen.target?.desired.appClients.find((client) => client.representation.clientId === "libredb-mobile");
    expect(mobile?.representation).toMatchObject({
      publicClient: true,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      redirectUris: ["org.libredb.mobile:/oauth2redirect"],
      attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "org.libredb.mobile:/oauth2redirect" },
    });
    expect(mobile?.representation.secret).toBeUndefined();
    const audiences = mobile?.protocolMappers.map((mapper) => ({
      audience: mapper.config["included.custom.audience"],
      access: mapper.config["access.token.claim"],
      id: mapper.config["id.token.claim"],
    }));
    expect(audiences).toEqual([
      { audience: "libredb-studio-api", access: "true", id: "false" },
      { audience: "libredb-platform-api", access: "true", id: "false" },
    ]);
  });

  test("leaves libredb-mobile out without it", async () => {
    const step = converge();
    await runKeycloakJob(installation(), manifestFixture(), jobIO(new MemoryObjects(), keycloak("managed").fetcher).io, step.functions);
    expect(step.seen.target?.desired.appClients.map((client) => client.representation.clientId)).not.toContain("libredb-mobile");
  });
});

describe("adminTarget", () => {
  test("refuses provisioning manual and a missing admin credential", () => {
    const sources = { readFile: () => undefined, env: {}, redactor: new Redactor() };
    expect(() => adminTarget(installation(MANUAL_KEYCLOAK), sources)).toThrow("provisioning is manual");
    expect(() => adminTarget(installation(INSTALLER_KEYCLOAK), sources)).toThrow("does not exist");
  });

  test("refuses a managed Keycloak whose bootstrap secret is not mounted", () => {
    expect(() => adminTarget(installation(), { readFile: () => undefined, env: {}, redactor: new Redactor() })).toThrow(
      `Secret ${K8S_NAMES.keycloakConfig} holds no ${STORE_KEYS.keycloakBootstrapSecret}`,
    );
  });

  test("an admin user signs in through admin-cli and reaches the Admin API at the base URL without an adminUrl", () => {
    const config = installation({
      keycloak: {
        mode: "external",
        realm: "corp",
        external: { baseUrl: "https://auth.libredb.test", adminUser: "admin", adminPasswordEnv: "CORP_ADMIN_PASSWORD" },
      },
    });
    const target = adminTarget(config, { readFile, env: { CORP_ADMIN_PASSWORD: "pw" }, redactor: new Redactor() });
    expect(target).toEqual({
      baseUrl: "https://auth.libredb.test",
      credentials: { realm: "master", clientId: "admin-cli", username: "admin", password: "pw" },
    });
  });
});

describe("ensureManagedRealm", () => {
  test("creates the realm with the installer's managed settings", async () => {
    const writes: unknown[] = [];
    const admin = { find: async () => undefined, write: async (...args: unknown[]) => writes.push(args) } as never;
    expect(await ensureManagedRealm(admin, "libredb")).toBe("created");
    expect(JSON.stringify(writes)).toContain(`"${MANAGED_ATTRIBUTE}":"true"`);
  });
});

describe("waitForKeycloak", () => {
  test("waits while Keycloak refuses connections, then returns once it answers", async () => {
    let attempts = 0;
    const lines: string[] = [];
    const slept: number[] = [];
    const fetcher = (async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("fetch failed");
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    await waitForKeycloak("http://keycloak:8080", { fetch: fetcher, log: (line) => lines.push(line), sleep: async (ms) => void slept.push(ms), now: () => 0 });
    expect(attempts).toBe(3);
    expect(slept).toEqual([3000, 3000]);
    expect(lines).toEqual(["keycloak: waiting for http://keycloak:8080 to answer", "keycloak: http://keycloak:8080 answers"]);
  });

  test("fails with the last connection error once the timeout passed", async () => {
    let clock = 0;
    const fetcher = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const waiting = waitForKeycloak("http://keycloak:8080", {
      fetch: fetcher,
      log: () => {},
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      timeoutMs: 10_000,
      intervalMs: 4_000,
    });
    await expect(waiting).rejects.toThrow("Keycloak at http://keycloak:8080 did not answer within 10 s: fetch failed");
  });
});
