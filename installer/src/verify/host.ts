// The host checks of `verify`: every service of the installation healthy, the installer clock within 15 s of
// PostgreSQL and Keycloak, and each app's NO_PROXY covering the hosts of src/model/no-proxy.ts.
import { z } from "zod";
import type { ComposeContainer } from "../adapters/docker";
import { parseComposeEnvFile } from "../render/compose";
import { parseResult, parseResults, resultQuery, runScript, type PsqlLogin, type SqlRunner } from "../sql/runner";
import type { Check } from "./catalogue";
import { failed, PASSED } from "./platform";

export interface HostCheckContext {
  /** The installer's clock, in epoch milliseconds. */
  now: () => number;
  sql: SqlRunner;
  /** The role that reads the PostgreSQL clock: the admin of a managed server, an app role of an external one. */
  admin: PsqlLogin;
  /**
   * Keycloak's clock in epoch milliseconds. Keycloak 26 sends no Date header, so the clock is read from the `iat` of
   * a token it issues.
   */
  keycloakClock: { what: string; read: () => Promise<number> };
  /** Reads a file on the host, such as an app's env file. */
  readFile: (path: string) => string;
  /** The env files of the apps, Platform's and Studio's. */
  appEnvFiles: readonly string[];
  /** The hosts that NO_PROXY must hold (src/model/no-proxy.ts). */
  noProxyHosts: readonly string[];
  /** Every service of the installation that runs, in compose order. */
  services: readonly string[];
  containers: () => Promise<ComposeContainer[]>;
}

type HostChecks = { host: HostCheckContext };

/** The largest skew between two clocks that the installer accepts. */
export const MAX_CLOCK_SKEW_MS = 15_000;

/** The PostgreSQL clock in epoch milliseconds. */
export function clockScript(): string {
  return `${resultQuery("clock", "to_jsonb((extract(epoch FROM clock_timestamp()) * 1000)::float8)")}\n`;
}

/**
 * Compares another clock with the installer clock, both in epoch milliseconds, and names both when they are more than
 * 15 s apart. Preflight compares an external Keycloak's clock the same way.
 */
export function clockSkewProblem(what: string, other: number, installer: number): string | undefined {
  const apart = Math.abs(other - installer);
  if (apart <= MAX_CLOCK_SKEW_MS) return undefined;
  return (
    `${what} reads ${new Date(other).toISOString()} and the installer clock ${new Date(installer).toISOString()}, ` +
    `${(apart / 1000).toFixed(1)} s apart, and the limit is ${MAX_CLOCK_SKEW_MS / 1000} s`
  );
}

/** Reads a clock between two readings of the installer clock and compares it with their midpoint. */
async function skew(
  context: { now: () => number },
  what: string,
  read: () => Promise<number>,
): Promise<string | undefined> {
  const before = context.now();
  const other = await read();
  return clockSkewProblem(what, other, (before + context.now()) / 2);
}

/**
 * Compares the PostgreSQL clock, read as the login, with the installer clock, and names both when they are more than
 * 15 s apart. Preflight runs it against an external server as well.
 */
export function postgresClockSkew(context: { now: () => number; sql: SqlRunner; login: PsqlLogin }): Promise<string | undefined> {
  return skew(context, "the PostgreSQL clock", async () => {
    const result = await runScript(context.sql, context.login, clockScript());
    return parseResult(z.number(), parseResults(result.stdout).get("clock"), "PostgreSQL clock");
  });
}

/** clock-skew: the installer clock is within 15 s of PostgreSQL's clock and of Keycloak's. */
export const clockSkewCheck: Check<HostChecks> = {
  id: "clock-skew",
  async run({ host }) {
    const problems: string[] = [];
    const postgres = await postgresClockSkew({ now: host.now, sql: host.sql, login: host.admin });
    if (postgres !== undefined) problems.push(postgres);
    const keycloak = await skew(host, host.keycloakClock.what, host.keycloakClock.read);
    if (keycloak !== undefined) problems.push(keycloak);
    return problems.length === 0 ? PASSED : failed(problems.join("; "));
  },
};

/**
 * no-proxy: NO_PROXY, and no_proxy when an env file sets it, of each app's env file hold every host that
 * src/model/no-proxy.ts lists.
 */
export const noProxyCheck: Check<HostChecks> = {
  id: "no-proxy",
  async run({ host }) {
    const problems: string[] = [];
    for (const file of host.appEnvFiles) {
      const env = parseComposeEnvFile(host.readFile(file));
      if (!env.has("NO_PROXY")) {
        problems.push(`${file} sets no NO_PROXY`);
        continue;
      }
      for (const name of ["NO_PROXY", "no_proxy"]) {
        const value = env.get(name);
        if (value === undefined) continue;
        const listed = value.split(",").map((entry) => entry.trim());
        const missing = host.noProxyHosts.filter((entry) => !listed.includes(entry));
        if (missing.length > 0) problems.push(`${name} of ${file} misses ${missing.join(", ")}`);
      }
    }
    return problems.length === 0 ? PASSED : failed(problems.join("; "));
  },
};

/**
 * components-healthy: every service of the installation runs and reports healthy. The healthchecks of the compose
 * file ask PostgreSQL through pg_isready and Keycloak through :9000/health/ready.
 */
export const componentsHealthyCheck: Check<HostChecks> = {
  id: "components-healthy",
  async run({ host }) {
    const containers = await host.containers();
    const problems = host.services.flatMap((service) => {
      const container = containers.find((candidate) => candidate.service === service);
      if (container === undefined) return [`${service} has no container`];
      if (container.state === "running" && container.health === "healthy") return [];
      const health = container.health === "" ? "reports no health status" : container.health;
      return [`${service} is ${container.state} and ${health}`];
    });
    return problems.length === 0 ? PASSED : failed(problems.join("; "));
  },
};

/** The host checks, in the order verify runs them. */
export const HOST_CHECKS: readonly Check<HostChecks>[] = [componentsHealthyCheck, clockSkewCheck, noProxyCheck];
