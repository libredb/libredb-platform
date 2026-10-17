// Wraps the Docker CLI calls of Docker mode. Every call runs through the exec adapter, so its output is redacted
// and bounded by a timeout, and a failed call rejects with ExecError instead of returning a partial answer.
import type { NetworkSpec, ObservedNetwork } from "../docker/project";
import type { Redactor } from "../log/redact";
import { exec, type ExecResult, type OutputLine } from "./exec";

export interface DockerOptions {
  redactor: Redactor;
  log: (line: OutputLine) => void;
  /** The docker binary, `docker` on the PATH by default. */
  binary?: string;
  env?: Record<string, string | undefined>;
}

/** The Compose project and file a compose call works on. */
export interface ComposeTarget {
  project: string;
  file: string;
}

/** One container of `docker compose ps --format json`, reduced to the fields the installer reads. */
export interface ComposeContainer {
  id: string;
  name: string;
  service: string;
  state: string;
  /** `healthy`, `unhealthy`, `starting`, or empty for a service without a healthcheck. */
  health: string;
  image: string;
}

export interface ImageDetails {
  id: string;
  repoDigests: string[];
}

const QUICK_MS = 60_000;
const LONG_MS = 15 * 60_000;

function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`docker compose ps: expected a string field ${key}`);
  return value;
}

/** Parses `docker compose ps --format json`, which prints one JSON object per line, or one array on older releases. */
export function parseComposePs(output: string): ComposeContainer[] {
  const trimmed = output.trim();
  if (trimmed === "") return [];
  const records: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed.split("\n").map((line) => JSON.parse(line) as unknown);
  return records.map((raw) => {
    const record = raw as Record<string, unknown>;
    return {
      id: field(record, "ID"),
      name: field(record, "Name"),
      service: field(record, "Service"),
      state: field(record, "State"),
      health: field(record, "Health"),
      image: field(record, "Image"),
    };
  });
}

/** `docker compose version --short` prints `2.29.1` or `v2.29.1`. */
export function parseComposeVersion(output: string): string {
  return output.trim().replace(/^v/, "");
}

export class Docker {
  readonly #options: DockerOptions;

  constructor(options: DockerOptions) {
    this.#options = options;
  }

  #run(args: readonly string[], timeoutMs: number, extra: { check?: boolean } = {}): Promise<ExecResult> {
    return exec([this.#options.binary ?? "docker", ...args], {
      redactor: this.#options.redactor,
      log: this.#options.log,
      env: this.#options.env,
      timeoutMs,
      check: extra.check ?? true,
    });
  }

  #compose(target: ComposeTarget, args: readonly string[], timeoutMs: number): Promise<ExecResult> {
    return this.#run(["compose", "-p", target.project, "-f", target.file, ...args], timeoutMs);
  }

  /** The client and server versions of the Docker Engine. */
  async version(): Promise<{ client: string; server: string }> {
    const result = await this.#run(["version", "--format", "{{json .}}"], QUICK_MS);
    const parsed = JSON.parse(result.stdout) as { Client?: { Version?: unknown }; Server?: { Version?: unknown } };
    const client = parsed.Client?.Version;
    const server = parsed.Server?.Version;
    if (typeof client !== "string" || typeof server !== "string") {
      throw new Error("docker version did not report both a client and a server version");
    }
    return { client, server };
  }

  /** The version of the Compose v2 plugin; rejects when the plugin is missing. */
  async composeVersion(): Promise<string> {
    const result = await this.#run(["compose", "version", "--short"], QUICK_MS);
    return parseComposeVersion(result.stdout);
  }

  /** Validates the project and returns the normalized model as Compose prints it, redacted. */
  async composeConfig(target: ComposeTarget): Promise<string> {
    return (await this.#compose(target, ["config"], QUICK_MS)).stdout;
  }

  /**
   * `up -d --wait`: creates or recreates the services and waits until they are running and healthy.
   * `forceRecreate` recreates them even when Compose sees no change in their definition.
   */
  async up(target: ComposeTarget, services: readonly string[] = [], options: { forceRecreate?: boolean } = {}): Promise<void> {
    const force = options.forceRecreate === true ? ["--force-recreate"] : [];
    await this.#compose(target, ["up", "-d", "--wait", ...force, ...services], LONG_MS);
  }

  /**
   * `--profile <profile> run --rm --no-deps -T <service> [args]`: runs a one-shot job of the project without a
   * terminal and without starting another service, and resolves with its exit code and redacted output whatever
   * the code, so the caller can read a failed job's log.
   */
  async runJob(
    target: ComposeTarget,
    service: string,
    options: { profile: string; args?: readonly string[] },
  ): Promise<ExecResult> {
    const args = ["--profile", options.profile, "run", "--rm", "--no-deps", "-T", service, ...(options.args ?? [])];
    return this.#run(["compose", "-p", target.project, "-f", target.file, ...args], LONG_MS, { check: false });
  }

  /** Inspects one network, or returns undefined when it does not exist. */
  async networkInspect(name: string): Promise<ObservedNetwork | undefined> {
    const result = await this.#run(["network", "inspect", "--format", "{{json .}}", name], QUICK_MS, { check: false });
    if (result.exitCode !== 0) {
      if (/not found/i.test(result.stderr)) return undefined;
      throw new Error(`docker network inspect ${name} exited with code ${result.exitCode}: ${result.stderr.trim()}`);
    }
    const parsed = JSON.parse(result.stdout) as { Name?: unknown; Internal?: unknown; Labels?: unknown };
    if (typeof parsed.Name !== "string" || typeof parsed.Internal !== "boolean") {
      throw new Error(`docker network inspect ${name} did not report a name and the internal flag`);
    }
    const labels = (parsed.Labels ?? {}) as Record<string, unknown>;
    return {
      name: parsed.Name,
      internal: parsed.Internal,
      labels: Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)])),
    };
  }

  /** Creates a bridge network with the labels Compose expects of a network of its project. */
  async networkCreate(network: NetworkSpec, labels: Record<string, string>): Promise<void> {
    const args = ["network", "create", "--driver", "bridge"];
    if (network.internal) args.push("--internal");
    for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
    await this.#run([...args, network.name], QUICK_MS);
  }

  /** Every container of the project, stopped ones included. */
  async ps(target: ComposeTarget): Promise<ComposeContainer[]> {
    return parseComposePs((await this.#compose(target, ["ps", "--all", "--format", "json"], QUICK_MS)).stdout);
  }

  /** Pulls one image reference, such as `docker.io/library/caddy@sha256:<digest>`. */
  async pull(reference: string): Promise<void> {
    await this.#run(["pull", reference], LONG_MS);
  }

  /** Inspects one local image, or returns undefined when it is not present. */
  async imageInspect(reference: string): Promise<ImageDetails | undefined> {
    const result = await this.#run(["image", "inspect", "--format", "{{json .}}", reference], QUICK_MS, {
      check: false,
    });
    if (result.exitCode !== 0) {
      if (/no such image/i.test(result.stderr)) return undefined;
      throw new Error(`docker image inspect ${reference} exited with code ${result.exitCode}: ${result.stderr.trim()}`);
    }
    const parsed = JSON.parse(result.stdout) as { Id?: unknown; RepoDigests?: unknown };
    if (typeof parsed.Id !== "string" || !Array.isArray(parsed.RepoDigests)) {
      throw new Error(`docker image inspect ${reference} did not report an id and repo digests`);
    }
    return { id: parsed.Id, repoDigests: parsed.RepoDigests.map(String) };
  }
}
