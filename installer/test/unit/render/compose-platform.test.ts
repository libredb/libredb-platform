import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { EnvRenderError } from "../../../src/model/env-render";
import {
  JOBS_PROFILE,
  PLATFORM_ENV_FILE,
  PLATFORM_MIGRATE_ENV_FILE,
  PLATFORM_MIGRATE_SERVICE,
  PLATFORM_SERVICE,
  parseComposeEnvFile,
  renderCompose,
  renderComposeEnvFile,
} from "../../../src/render/compose";
import { desiredFixture, TRUST_FIXTURE } from "./fixture";

interface ComposeDocument {
  services: Record<string, Record<string, unknown>>;
  volumes: Record<string, unknown>;
}

function compose(sets: readonly string[] = []): ComposeDocument {
  return parse(renderCompose(desiredFixture(sets), TRUST_FIXTURE)) as ComposeDocument;
}

function service(name: string): Record<string, unknown> {
  const found = compose().services[name];
  if (found === undefined) throw new Error(`the rendered compose file has no service ${name}`);
  return found;
}

describe("renderCompose platform", () => {
  test("only platform-migrate receives the env file that holds MIGRATE_DATABASE_URL", () => {
    const services = compose().services;
    const withMigrateEnv = Object.entries(services)
      .filter(([, definition]) => ((definition.env_file as string[] | undefined) ?? []).includes(PLATFORM_MIGRATE_ENV_FILE))
      .map(([name]) => name);
    expect(withMigrateEnv).toEqual([PLATFORM_MIGRATE_SERVICE]);
    expect(PLATFORM_MIGRATE_ENV_FILE).toBe("/opt/libredb/env/platform-migrate.env");
    expect(services[PLATFORM_SERVICE]?.env_file).toEqual([PLATFORM_ENV_FILE]);
    expect(PLATFORM_ENV_FILE).toBe("/opt/libredb/env/platform.env");
    // No service carries a variable of its own, so the env files alone decide what each container receives.
    for (const name of [PLATFORM_SERVICE, PLATFORM_MIGRATE_SERVICE]) expect(services[name]?.environment).toBeUndefined();
    expect(renderCompose(desiredFixture(), TRUST_FIXTURE)).not.toContain("MIGRATE_DATABASE_URL");
  });

  test("platform-migrate runs migrate from the Platform image by digest in profile jobs, on the data network only", () => {
    const migrate = service(PLATFORM_MIGRATE_SERVICE);
    expect(migrate.image).toBe(desiredFixture().images.platform);
    expect(migrate.image).toMatch(/^ghcr\.io\/libredb\/libredb-platform@sha256:[0-9a-f]{64}$/);
    expect(migrate.profiles).toEqual([JOBS_PROFILE]);
    expect(JOBS_PROFILE).toBe("jobs");
    expect(migrate.command).toEqual(["migrate"]);
    expect(migrate.networks).toEqual({ data: {} });
    expect(migrate.volumes).toEqual(["/opt/libredb/ca:/etc/libredb/ca:ro"]);
    // A one-shot job: Compose starts it only through `run`, and without a restart policy it never restarts.
    expect(migrate.restart).toBeUndefined();
    expect(migrate.user).toBe("1001");
    expect(migrate.cap_drop).toEqual(["ALL"]);
    expect(migrate.security_opt).toEqual(["no-new-privileges:true"]);
  });

  test("platform serves as uid 1001 with a read-only root filesystem, tmpfs for /tmp and /app/.next/cache, the uploads volume, no capabilities and no-new-privileges", () => {
    const platform = service(PLATFORM_SERVICE);
    expect(platform.image).toBe(desiredFixture().images.platform);
    expect(platform.command).toEqual(["serve"]);
    expect(platform.user).toBe("1001");
    expect(platform.read_only).toBe(true);
    expect(platform.tmpfs).toEqual(["/tmp", "/app/.next/cache"]);
    expect(platform.volumes).toEqual(["platform-uploads:/app/uploads", "/opt/libredb/ca:/etc/libredb/ca:ro"]);
    expect(compose().volumes["platform-uploads"]).toEqual({});
    expect(platform.cap_drop).toEqual(["ALL"]);
    expect(platform.security_opt).toEqual(["no-new-privileges:true"]);
    expect(platform.restart).toBe("unless-stopped");
    expect(platform.profiles).toBeUndefined();
  });

  test("platform joins networks edge and data and its healthcheck asks the liveness route without a $", () => {
    const platform = service(PLATFORM_SERVICE);
    expect(platform.networks).toEqual({ edge: {}, data: {} });
    const healthcheck = platform.healthcheck as { test: string[] };
    expect(healthcheck.test.slice(0, 3)).toEqual(["CMD", "node", "-e"]);
    expect(healthcheck.test[3]).toContain("http://127.0.0.1:3000/api/health/live");
    // Compose interpolates $ in the file, so the command must not use one.
    expect(healthcheck.test[3]).not.toContain("$");
  });

  test("the edge forwards the platform host to the platform service on port 3000", () => {
    expect(desiredFixture().edge.sites.find((site) => site.endpoint === "platform")?.upstream).toBe(
      `${PLATFORM_SERVICE}:3000`,
    );
  });
});

describe("renderComposeEnvFile", () => {
  test("writes plain values unquoted and in order, and leaves out absent variables", () => {
    expect(
      renderComposeEnvFile({
        DATABASE_URL: "postgresql://u:p@postgres:5432/libredb?schema=platform&sslmode=verify-full",
        PLATFORM_ORGANIZATION_NAME: "LibreDB E2E",
        HTTPS_PROXY: undefined,
      }),
    ).toBe(
      "DATABASE_URL=postgresql://u:p@postgres:5432/libredb?schema=platform&sslmode=verify-full\n" +
        "PLATFORM_ORGANIZATION_NAME=LibreDB E2E\n",
    );
  });

  test("single-quotes a value that Compose would interpolate, unquote or cut at a comment", () => {
    expect(
      renderComposeEnvFile({
        A: "R&D $Team",
        B: "a #b",
        C: '"quoted"',
        D: "back\\slash",
        E: " padded ",
        F: "",
      }),
    ).toBe("A='R&D $Team'\nB='a #b'\nC='\"quoted\"'\nD='back\\slash'\nE=' padded '\nF=\n");
  });

  test("double-quotes a value with a single quote and nothing Compose reads inside double quotes", () => {
    expect(renderComposeEnvFile({ PLATFORM_ORGANIZATION_NAME: "O'Brien # Sons" })).toBe(
      "PLATFORM_ORGANIZATION_NAME=\"O'Brien # Sons\"\n",
    );
  });

  test("refuses a value Compose cannot carry, naming the variable and never the value", () => {
    const refuse = (env: Record<string, string>) => {
      try {
        renderComposeEnvFile(env);
      } catch (error) {
        return error;
      }
      throw new Error("renderComposeEnvFile accepted the value");
    };
    const quote = refuse({ PLATFORM_ORGANIZATION_NAME: "O'Brien $Inc" });
    expect(quote).toBeInstanceOf(EnvRenderError);
    expect((quote as Error).message).toContain("PLATFORM_ORGANIZATION_NAME");
    expect((quote as Error).message).not.toContain("O'Brien");
    expect((refuse({ AUTH_SECRET: "line\nbreak" }) as Error).message).toContain("AUTH_SECRET");
    expect((refuse({ "BAD KEY": "x" }) as Error).message).toContain("BAD KEY");
  });
});

describe("parseComposeEnvFile", () => {
  test("reads back every value renderComposeEnvFile writes, verbatim", () => {
    const env = {
      A: "R&D $Team",
      B: "a #b",
      C: '"quoted"',
      D: "back\\slash",
      E: " padded ",
      F: "",
      G: "O'Brien # Sons",
      NO_PROXY: "platform.example.com,localhost",
    };
    const text = `# a comment\n\n${renderComposeEnvFile(env)}`;
    expect(Object.fromEntries(parseComposeEnvFile(text))).toEqual(env);
  });

  test("refuses a line that is not KEY=value, naming its number and never its content", () => {
    expect(() => parseComposeEnvFile("A=1\nsecret-without-equals\n")).toThrow(
      "line 2 of the env file is not of the form KEY=value",
    );
  });
});
