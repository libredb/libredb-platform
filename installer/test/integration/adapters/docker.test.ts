// Runs the Docker adapter against the local Docker Engine. It pulls nothing and starts no container.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { Docker, parseComposePs } from "../../../src/adapters/docker";
import { ExecError } from "../../../src/adapters/exec";
import { Redactor } from "../../../src/log/redact";
import {
  INSTALL_ROOT,
  KEYCLOAK_ENV_FILE,
  PLATFORM_ENV_FILE,
  PLATFORM_MIGRATE_ENV_FILE,
  POSTGRES_ENV_FILE,
  renderCompose,
  STUDIO_ENV_FILE,
} from "../../../src/render/compose";
import { desiredFixture, TRUST_FIXTURE } from "../../unit/render/fixture";

const scratch = mkdtempSync(join(tmpdir(), "libredb-docker-it-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const docker = new Docker({ redactor: new Redactor(), log: () => {} });

describe("Docker adapter", () => {
  test("reports the engine and Compose plugin versions", async () => {
    const version = await docker.version();
    expect(version.server).toMatch(/^\d+\.\d+/);
    expect(await docker.composeVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("docker compose config accepts the rendered skeleton and keeps the edge aliases and the internal data network", async () => {
    // The rendered file names /opt/libredb paths; the test moves them under a scratch root.
    const root = join(scratch, "opt-libredb");
    mkdirSync(join(root, "env"), { recursive: true });
    // Compose config stats every env_file the rendered services name.
    for (const envFile of [POSTGRES_ENV_FILE, KEYCLOAK_ENV_FILE, PLATFORM_ENV_FILE, PLATFORM_MIGRATE_ENV_FILE, STUDIO_ENV_FILE]) {
      writeFileSync(envFile.replace(INSTALL_ROOT, root), "PLACEHOLDER=not-a-real-secret\n", { mode: 0o600 });
    }
    const file = join(root, "compose.yaml");
    writeFileSync(file, renderCompose(desiredFixture(), TRUST_FIXTURE).replaceAll(`${INSTALL_ROOT}/`, `${root}/`));

    const normalized = parse(await docker.composeConfig({ project: "libredb", file })) as {
      name: string;
      services: { edge: { networks: { edge: { aliases: string[] } } } };
      networks: { data: { internal: boolean } };
    };
    expect(normalized.name).toBe("libredb");
    expect(normalized.services.edge.networks.edge.aliases).toEqual([
      "platform.libredb.test",
      "studio.libredb.test",
      "auth.libredb.test",
    ]);
    expect(normalized.networks.data.internal).toBe(true);
  });

  test("docker compose config rejects an invalid file with ExecError", async () => {
    const file = join(scratch, "invalid.yaml");
    writeFileSync(file, "services:\n  edge:\n    restart: sometimes\n");
    await expect(docker.composeConfig({ project: "libredb-invalid", file })).rejects.toBeInstanceOf(ExecError);
  });

  test("ps reads the rendered skeleton while no env file exists yet, as on the first apply", async () => {
    const root = join(scratch, "first-apply");
    mkdirSync(root, { recursive: true });
    const file = join(root, "compose.yaml");
    writeFileSync(file, renderCompose(desiredFixture(), TRUST_FIXTURE).replaceAll(`${INSTALL_ROOT}/`, `${root}/`));
    expect(await docker.ps({ project: "libredb-it-first-apply", file })).toEqual([]);
  });

  test("ps lists no container for a project that does not run", async () => {
    const file = join(scratch, "empty.yaml");
    writeFileSync(file, "services:\n  idle:\n    image: docker.io/library/busybox\n");
    expect(await docker.ps({ project: "libredb-it-absent", file })).toEqual([]);
  });

  test("image inspect of an absent image returns undefined", async () => {
    expect(await docker.imageInspect(`docker.io/library/caddy@sha256:${"0".repeat(64)}`)).toBeUndefined();
  });
});

describe("parseComposePs", () => {
  const row = { ID: "abc", Name: "libredb-edge-1", Service: "edge", State: "running", Health: "healthy", Image: "x" };
  const parsed = { id: "abc", name: "libredb-edge-1", service: "edge", state: "running", health: "healthy", image: "x" };

  test("reads one JSON object per line and the array form of older Compose releases", () => {
    expect(parseComposePs(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`)).toEqual([parsed, parsed]);
    expect(parseComposePs(JSON.stringify([row]))).toEqual([parsed]);
  });

  test("rejects a row without a field it reads", () => {
    expect(() => parseComposePs(JSON.stringify({ ...row, Health: undefined }))).toThrow("Health");
  });
});
