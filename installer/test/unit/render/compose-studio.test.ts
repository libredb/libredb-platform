import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parse } from "yaml";
import type { ComposeContainer } from "../../../src/adapters/docker";
import { loadConfig } from "../../../src/config/load";
import type { FileSpec } from "../../../src/docker/converge";
import type { StepRun } from "../../../src/engine/step";
import { computeDesired, type DesiredInstallation } from "../../../src/model/desired";
import type { StudioEnvInputs } from "../../../src/model/studio-env";
import type { ReleaseManifest } from "../../../src/release/manifest";
import {
  APP_UID,
  renderCompose,
  STUDIO_ENV_FILE,
  STUDIO_HOSTNAME,
  STUDIO_KEYRING_FILE,
  STUDIO_KEYRING_MOUNT,
  STUDIO_SERVICE,
  studioEnvFile,
  studioKeyringFile,
} from "../../../src/render/compose";
import { KeyringError } from "../../../src/secrets/keyring";
import { generateSealKeyPair } from "../../../src/secrets/seal-keys";
import { emptyState } from "../../../src/state/store";
import type { DeployObservation } from "../../../src/steps/deploy";
import type { DockerContext } from "../../../src/steps/docker-context";
import { studioDeployStep } from "../../../src/steps/studio-deploy";
import { manifestFixture } from "../release/fixture";
import { TRUST_FIXTURE } from "./fixture";

const CONFIG = join(import.meta.dir, "..", "..", "fixtures", "configs", "docker-minimal.yaml");

const INPUTS: StudioEnvInputs = {
  postgres: { host: "postgres", port: 5432 },
  secrets: {
    oidcClientSecret: "studio-client-secret",
    jwtSecret: "jwt-secret",
    storageEncryptionKey: "storage-key",
    databasePassword: "studio-db-password",
  },
};

/** The desired model of the minimal Docker fixture, with the release manifest fixture changed by `edit`. */
function desired(
  edit: (manifest: ReleaseManifest) => void = () => {},
  sets: readonly string[] = [],
): DesiredInstallation {
  const manifest = manifestFixture();
  edit(manifest);
  return computeDesired(loadConfig({ file: CONFIG, sets }), manifest);
}

type Service = Record<string, unknown>;

function services(model: DesiredInstallation = desired()): Record<string, Service> {
  return (parse(renderCompose(model, TRUST_FIXTURE)) as { services: Record<string, Service> }).services;
}

function studio(model?: DesiredInstallation): Service {
  const found = services(model)[STUDIO_SERVICE];
  if (found === undefined) throw new Error(`the rendered compose file has no service ${STUDIO_SERVICE}`);
  return found;
}

interface Mount {
  service: string;
  source: string;
  target: string;
  readOnly: boolean;
}

/** Every mount of every service, written in the short or the long syntax of Compose. */
function mounts(model: DesiredInstallation = desired()): Mount[] {
  return Object.entries(services(model)).flatMap(([service, definition]) =>
    ((definition.volumes as unknown[] | undefined) ?? []).map((volume): Mount => {
      if (typeof volume === "string") {
        const [source = "", target = "", options = ""] = volume.split(":");
        return { service, source, target, readOnly: options.split(",").includes("ro") };
      }
      const long = volume as { source?: string; target?: string; read_only?: boolean };
      return { service, source: long.source ?? "", target: long.target ?? "", readOnly: long.read_only === true };
    }),
  );
}

function envLines(model: DesiredInstallation): string[] {
  return studioEnvFile(model, INPUTS)
    .content.split("\n")
    .filter((line) => line !== "");
}

describe("renderCompose studio", () => {
  test("the keyring is mounted read-only into studio and into no other service", () => {
    const secretsDir = "/opt/libredb/secrets";
    // Nothing else of the secrets directory reaches a container: installer.env and the secret store stay on the host.
    const fromSecrets = mounts().filter(
      (mount) => mount.source === secretsDir || mount.source.startsWith(`${secretsDir}/`),
    );
    expect(fromSecrets).toEqual([
      { service: STUDIO_SERVICE, source: STUDIO_KEYRING_FILE, target: STUDIO_KEYRING_MOUNT, readOnly: true },
    ]);
    expect(STUDIO_KEYRING_FILE).toBe("/opt/libredb/secrets/studio-keyring.json");
    // Studio reads the keyring where its env file names it.
    expect(envLines(desired())).toContain(`GOVERNANCE_PRIVATE_KEYS_FILE=${STUDIO_KEYRING_MOUNT}`);
    // A keyring missing on the host fails the start instead of becoming a directory there.
    expect(studio().volumes).toContainEqual({
      type: "bind",
      source: STUDIO_KEYRING_FILE,
      target: STUDIO_KEYRING_MOUNT,
      read_only: true,
      bind: { create_host_path: false },
    });
  });

  test("the studio service keeps one instance id across recreates", () => {
    const before = desired();
    // An upgrade to another Studio image and a changed env file each recreate the container.
    const after = desired(
      (manifest) => {
        manifest.images.studio.digest = `sha256:${"9".repeat(64)}`;
      },
      ["network.httpsProxy=http://proxy.corp:3128"],
    );
    expect(studio(after).image).not.toBe(studio(before).image);
    expect(studioEnvFile(after, INPUTS).content).not.toBe(studioEnvFile(before, INPUTS).content);
    for (const model of [before, after]) {
      expect(studio(model).hostname).toBe(STUDIO_HOSTNAME);
      expect(envLines(model)).toContain(`GOVERNANCE_INSTANCE_ID=${STUDIO_HOSTNAME}`);
    }
    expect(STUDIO_HOSTNAME).toBe("libredb-studio");
    // One container whose name Compose derives from the project and the service, never a scaled set.
    expect(studio(before).container_name).toBeUndefined();
    expect(studio(before).deploy).toBeUndefined();
    expect(studio(before).scale).toBeUndefined();
  });

  test("OIDC_LOGOUT_HINT is written only when the release manifest sets studio.logoutHintVerified", () => {
    const hint = (model: DesiredInstallation) => envLines(model).filter((line) => line.startsWith("OIDC_LOGOUT_HINT="));
    expect(hint(desired())).toEqual([]);
    const verified = desired((manifest) => {
      manifest.studio.logoutHintVerified = true;
    });
    expect(hint(verified)).toEqual(["OIDC_LOGOUT_HINT=true"]);
  });

  test("studio runs the Studio image by digest as uid 1001 with a read-only root filesystem, tmpfs for /tmp and /app/.next/cache, the volume studio-data at /app/data, the CA bundle read-only, no capabilities and no-new-privileges", () => {
    const service = studio();
    expect(service.image).toBe(desired().images.studio);
    expect(service.image).toMatch(/^ghcr\.io\/libredb\/libredb-studio@sha256:[0-9a-f]{64}$/);
    expect(service.user).toBe("1001");
    expect(service.read_only).toBe(true);
    expect(service.tmpfs).toEqual(["/tmp", "/app/.next/cache"]);
    expect(mounts().filter((mount) => mount.service === STUDIO_SERVICE)).toEqual([
      { service: STUDIO_SERVICE, source: "studio-data", target: "/app/data", readOnly: false },
      { service: STUDIO_SERVICE, source: "/opt/libredb/ca", target: "/etc/libredb/ca", readOnly: true },
      { service: STUDIO_SERVICE, source: STUDIO_KEYRING_FILE, target: STUDIO_KEYRING_MOUNT, readOnly: true },
    ]);
    const { volumes } = parse(renderCompose(desired(), TRUST_FIXTURE)) as { volumes: Record<string, unknown> };
    expect(volumes["studio-data"]).toEqual({});
    // The hardening of the Studio chart's pods, which every governance install requires.
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    expect(service.restart).toBe("unless-stopped");
    expect(service.profiles).toBeUndefined();
  });

  test("studio alone reads studio.env, a root-only file with the governance values of contracts/env-inventory.yaml", () => {
    const service = studio();
    expect(service.env_file).toEqual([STUDIO_ENV_FILE]);
    expect(STUDIO_ENV_FILE).toBe("/opt/libredb/env/studio.env");
    expect(service.environment).toBeUndefined();
    // Platform and Studio never share an env file, because STORAGE_PROVIDER means different things in each.
    const readers = Object.entries(services())
      .filter(([, definition]) => ((definition.env_file as string[] | undefined) ?? []).includes(STUDIO_ENV_FILE))
      .map(([name]) => name);
    expect(readers).toEqual([STUDIO_SERVICE]);
    const { content: _content, ...file } = studioEnvFile(desired(), INPUTS);
    expect(file).toEqual({ path: STUDIO_ENV_FILE, mode: 0o600, uid: 0, gid: 0 });
    expect(envLines(desired())).toEqual(
      expect.arrayContaining([
        "NEXT_PUBLIC_AUTH_PROVIDER=oidc",
        "OIDC_ROLE_CLAIM=libredb_roles",
        "OIDC_ADMIN_ROLES=admin",
        "OIDC_USER_ROLES=user",
        "OIDC_PROMPT=omit",
        "OIDC_AUTO_REDIRECT=true",
        "AUTH_SESSION_TTL_SECONDS=28800",
        "AUTH_BOOTSTRAP=off",
        "STORAGE_PROVIDER=postgres",
        "STORAGE_POSTGRES_SCHEMA=studio",
        "GOVERNANCE_SOURCE=postgres",
        "GOVERNANCE_POSTGRES_SCHEMA=bridge",
        "NODE_EXTRA_CA_CERTS=/etc/libredb/ca/ca.crt",
      ]),
    );
  });

  test("studio joins networks edge and data and its healthcheck asks the readiness route without a $", () => {
    const service = studio();
    expect(service.networks).toEqual({ edge: {}, data: {} });
    const healthcheck = service.healthcheck as { test: string[] };
    expect(healthcheck.test.slice(0, 3)).toEqual(["CMD", "node", "-e"]);
    expect(healthcheck.test[3]).toContain("http://127.0.0.1:3000/api/ready");
    // Compose interpolates $ in the file, so the command must not use one.
    expect(healthcheck.test[3]).not.toContain("$");
    // The edge forwards the studio host to this service on the port Studio listens on.
    expect(desired().edge.sites.find((site) => site.endpoint === "studio")?.upstream).toBe(`${STUDIO_SERVICE}:3000`);
    expect(envLines(desired())).toContain("PORT=3000");
  });

  test("the keyring holds the private key of every live seal key, with mode 0400 and the uid studio runs as for owner", () => {
    const [first, retired, second] = [generateSealKeyPair(), generateSealKeyPair(), generateSealKeyPair()];
    const file = studioKeyringFile([
      { ...first, state: "live" },
      { ...retired, state: "retired" },
      { ...second, state: "live" },
    ]);
    expect(file).toEqual({
      path: STUDIO_KEYRING_FILE,
      content: JSON.stringify({ version: 1, keys: [first.privateKey, second.privateKey] }),
      mode: 0o400,
      uid: 1001,
      gid: 1001,
    });
    expect(studio().user).toBe(String(APP_UID));
    expect(() => studioKeyringFile([{ ...retired, state: "retired" }])).toThrow(KeyringError);
  });
});

describe("studio-deploy plan", () => {
  const HASH = "a".repeat(64);
  const HEALTHY: ComposeContainer = {
    id: "1",
    name: "libredb-studio-1",
    service: "studio",
    state: "running",
    health: "healthy",
    image: "studio",
  };
  const ENV: FileSpec = {
    path: STUDIO_ENV_FILE,
    content: "GOVERNANCE_INSTANCE_ID=libredb-studio\n",
    mode: 0o600,
    uid: 0,
    gid: 0,
  };
  const KEYRING: FileSpec = {
    path: STUDIO_KEYRING_FILE,
    content: '{"version":1,"keys":["new"]}',
    mode: 0o400,
    uid: 1001,
    gid: 1001,
  };

  function run(recorded: string | undefined): StepRun<DockerContext> {
    const state = emptyState();
    if (recorded !== undefined) {
      state.steps["studio-deploy"] = { result: "applied", finishedAt: "2026-10-15T00:00:00.000Z", inputHash: recorded };
    }
    return { context: { desired: desired() } as DockerContext, state, inputHash: HASH };
  }

  /** The env file and the keyring as rendered, each found on the host with the given content or missing. */
  function observation(
    onHost: { env?: string; keyring?: string },
    container: ComposeContainer | undefined,
  ): DeployObservation {
    const found = (spec: FileSpec, content: string | undefined) =>
      content === undefined
        ? undefined
        : { kind: "file" as const, mode: spec.mode, uid: spec.uid, gid: spec.gid, content };
    return {
      directories: [],
      files: [
        { spec: ENV, observed: found(ENV, onHost.env) },
        { spec: KEYRING, observed: found(KEYRING, onHost.keyring) },
      ],
      container,
    };
  }

  const summaries = async (observed: DeployObservation, stepRun: StepRun<DockerContext>) =>
    (await studioDeployStep.plan(observed, stepRun)).map((action) => action.summary);

  test("a first run writes the env file and the keyring, then starts studio", async () => {
    expect(await summaries(observation({}, undefined), run(undefined))).toEqual([
      `create ${STUDIO_ENV_FILE}`,
      `create ${STUDIO_KEYRING_FILE}`,
      "start studio",
    ]);
  });

  test("a converged studio plans nothing", async () => {
    const observed = observation({ env: ENV.content, keyring: KEYRING.content }, HEALTHY);
    expect(await summaries(observed, run(HASH))).toEqual([]);
  });

  test("a new keyring recreates the running studio, which reads its keyring only at start", async () => {
    const observed = observation({ env: ENV.content, keyring: '{"version":1,"keys":["old"]}' }, HEALTHY);
    expect(await summaries(observed, run(HASH))).toEqual([
      `update ${STUDIO_KEYRING_FILE}`,
      "recreate studio with its changed keyring",
    ]);
  });

  test("an unhealthy studio whose env file changed is recreated, not only started", async () => {
    const observed = observation(
      { env: "GOVERNANCE_INSTANCE_ID=old\n", keyring: KEYRING.content },
      { ...HEALTHY, health: "unhealthy" },
    );
    const actions = await studioDeployStep.plan(observed, run(HASH));
    expect(actions.map((action) => action.summary)).toEqual([
      `update ${STUDIO_ENV_FILE}`,
      "recreate studio with its changed env file",
    ]);
    expect(actions.at(-1)).toMatchObject({ kind: "service", service: STUDIO_SERVICE, recreate: true });
  });

  test("a changed configuration recreates studio once, whatever its files", async () => {
    const observed = observation({ env: ENV.content, keyring: '{"version":1,"keys":["old"]}' }, HEALTHY);
    expect(await summaries(observed, run("b".repeat(64)))).toEqual([
      `update ${STUDIO_KEYRING_FILE}`,
      "recreate studio with its changed configuration",
    ]);
  });
});
