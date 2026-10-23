// Drives Studio's sign-in through the managed Keycloak of an installation, and reads the installation's PostgreSQL.
// Studio sends a signed-out GET /login straight to Keycloak (OIDC_AUTO_REDIRECT). The first admin signs in with its
// temporary password and the required actions when no earlier spec did, or with the password and TOTP device an
// earlier spec of the run set. A user a spec created signs in with a password alone.
import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import {
  completeFirstLogin,
  saveSignedInFirstAdmin,
  signedInFirstAdmin,
  totp,
  type FirstLogin,
  type PasswordUser,
} from "./platform";

/** Studio's URL in test/fixtures/configs/docker.yaml; LIBREDB_E2E_STUDIO_URL points the Helm chart's suite elsewhere. */
export const STUDIO_URL = process.env.LIBREDB_E2E_STUDIO_URL ?? "https://studio.libredb.test";

/** The Studio container of the Compose project libredb. */
export const STUDIO_CONTAINER = "libredb-studio-1";

const TOTP_STEP_MS = 30_000;

/** Waits until a TOTP code other than the last one used is valid, because Keycloak accepts each code once. */
async function freshTotpWindow(usedAt: number): Promise<number> {
  const usedStep = Math.floor(usedAt / TOTP_STEP_MS);
  while (Math.floor(Date.now() / TOTP_STEP_MS) <= usedStep) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return Date.now();
}

/** Signs the first admin in to Studio and waits until the browser is back on Studio. */
export async function signInToStudio(page: Page, account: FirstLogin): Promise<void> {
  await page.goto(`${STUDIO_URL}/login`);
  await page.waitForURL((url) => url.pathname.endsWith("/protocol/openid-connect/auth"));
  const known = signedInFirstAdmin();
  if (known === undefined) {
    await completeFirstLogin(page, STUDIO_URL, account);
  } else {
    await page.locator("#username").fill(account.username);
    await page.locator("#password").fill(known.password);
    await page.locator("#kc-login").click();
    await page.locator("#otp").waitFor({ state: "visible" });
    const usedAt = await freshTotpWindow(known.totpUsedAt);
    await page.locator("#otp").fill(totp(known.totpSecret, usedAt));
    await page.locator("#kc-login").click();
    saveSignedInFirstAdmin({ ...known, totpUsedAt: usedAt });
  }
  await expect(page).toHaveURL((url) => url.origin === STUDIO_URL && url.pathname !== "/login");
}

/** Signs `user` in to Studio on Keycloak's form and waits until the browser is back on Studio. */
export async function signInToStudioAs(page: Page, user: PasswordUser): Promise<void> {
  await page.goto(`${STUDIO_URL}/login`);
  await page.waitForURL((url) => url.pathname.endsWith("/protocol/openid-connect/auth"));
  await page.locator("#username").fill(user.username);
  await page.locator("#password").fill(user.password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL((url) => url.origin === STUDIO_URL && url.pathname !== "/login");
}

/**
 * Leaves the Studio app for a JSON document of Studio's own origin, so that requests the spec sends from the page
 * carry the session cookie and Studio's origin while no script of the app runs beside them: the app would follow a
 * 401 to the sign-in page and sign the user in again on its own.
 */
export async function openStudioConsole(page: Page): Promise<void> {
  await page.goto(`${STUDIO_URL}/api/ready`);
}

/** A Studio answer: its status and its body, parsed as JSON when it is JSON; each caller reads the shape it expects. */
export interface StudioAnswer {
  status: number;
  body: unknown;
}

/** Sends a request to Studio from `page`, which must show a page of Studio's origin, as the Studio app sends it. */
export function studioRequest(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<StudioAnswer> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not every answer is JSON, such as an HTML error page; the caller sees its text.
      }
      return { status: response.status, body: parsed };
    },
    { path, method: init.method ?? (init.body === undefined ? "GET" : "POST"), body: init.body },
  );
}

/**
 * Runs a docker command against the installation's engine and returns its standard output. LIBREDB_E2E_DOCKER is the
 * docker command that reaches that engine, such as `docker exec <host> docker` for a Docker-in-Docker host, and
 * `docker` by default. A command that exits non-zero throws with its standard error.
 */
export function docker(args: string[]): string {
  const [binary, ...prefix] = (process.env.LIBREDB_E2E_DOCKER ?? "docker").split(/\s+/).filter(Boolean);
  return execFileSync(binary as string, [...prefix, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** The id of the Studio container, which a recreate changes and a runtime setting must not. */
export function studioContainerId(): string {
  return docker(["inspect", "--format", "{{.Id}}", STUDIO_CONTAINER]);
}

/** The environment of the Studio container, as the installer's env file set it. */
export function studioEnvironment(): Map<string, string> {
  const entries = JSON.parse(docker(["inspect", "--format", "{{json .Config.Env}}", STUDIO_CONTAINER])) as string[];
  return new Map(entries.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
}

/**
 * Runs SQL as the PostgreSQL superuser over the server's local socket inside its container, through the docker command
 * of LIBREDB_E2E_DOCKER.
 */
export function psqlAsSuperuser(database: string, sql: string): string {
  const script = `PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -A -t -v ON_ERROR_STOP=1 -U postgres -d ${database} -c "$1"`;
  return docker(["exec", "libredb-postgres-1", "sh", "-c", script, "sh", sql]);
}
