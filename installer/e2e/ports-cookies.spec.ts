// The ports endpoint style shares cookies across the apps, because browsers scope cookies by host and not by port,
// so Platform and Studio must never write a cookie of the same name. It runs against an
// installation of test/fixtures/configs/docker-ports.yaml, such as the one test/e2e/docker-ports.test.ts leaves: the
// first admin signs in to Platform on 443, with its first login or the account an earlier run saved, and then to
// Studio on 8443, each app's sidebar is toggled where it has one, and every cookie name an app sets, through
// Set-Cookie or document.cookie, is recorded under the port that set it.
// LIBREDB_E2E_PORTS_HOST names the one host (default lab.libredb.test), and LIBREDB_E2E_PORTS_PLATFORM,
// LIBREDB_E2E_PORTS_STUDIO and LIBREDB_E2E_PORTS_AUTH its ports (defaults 443, 8443 and 9443).
import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Response } from "@playwright/test";
import {
  completeFirstLogin,
  FIRST_ADMIN,
  firstAdminTemporaryPassword,
  saveSignedInFirstAdmin,
  signedInFirstAdmin,
  totp,
} from "./helpers/platform";

const HOST = process.env.LIBREDB_E2E_PORTS_HOST ?? "lab.libredb.test";
const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const PORTS = {
  platform: port("LIBREDB_E2E_PORTS_PLATFORM", 443),
  studio: port("LIBREDB_E2E_PORTS_STUDIO", 8443),
  auth: port("LIBREDB_E2E_PORTS_AUTH", 9443),
};
type App = keyof typeof PORTS;

const TOTP_STEP_MS = 30_000;

const origin = (number: number) => (number === 443 ? `https://${HOST}` : `https://${HOST}:${number}`);
const PLATFORM_URL = origin(PORTS.platform);
const STUDIO_URL = origin(PORTS.studio);

/** The app a URL on the one host belongs to, by its port, or undefined for another host. */
function appOf(url: string): App | undefined {
  const parsed = new URL(url);
  if (parsed.hostname !== HOST) return undefined;
  const number = parsed.port === "" ? 443 : Number(parsed.port);
  return (Object.keys(PORTS) as App[]).find((app) => PORTS[app] === number);
}

/** The name of a cookie in a Set-Cookie header or a document.cookie assignment. */
const cookieName = (text: string) => (text.split(";")[0] ?? "").split("=")[0]?.trim() ?? "";

/** Reports the name of every document.cookie assignment to the binding __libredbCookieWritten, then assigns it. */
const COOKIE_RECORDER = `(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  Object.defineProperty(Document.prototype, "cookie", {
    configurable: true,
    get() {
      return descriptor.get.call(this);
    },
    set(value) {
      const name = String(value).split(";")[0].split("=")[0].trim();
      void window.__libredbCookieWritten(name);
      descriptor.set.call(this, value);
    },
  });
})();`;

/**
 * Signs the first admin in on Keycloak's form: its first login on a fresh installation, or the password and TOTP
 * device a first login saved. Returns when the browser is back on the app at `appOrigin`.
 */
async function signInOnKeycloak(page: Page, appOrigin: string): Promise<void> {
  const known = signedInFirstAdmin();
  if (known === undefined) {
    await completeFirstLogin(page, appOrigin, {
      username: FIRST_ADMIN,
      temporaryPassword: firstAdminTemporaryPassword(),
      newPassword: `E2e-${randomUUID()}`,
      email: "libredb-admin@libredb.test",
      firstName: "LibreDB",
      lastName: "Admin",
    });
    return;
  }
  await page.locator("#username").fill(FIRST_ADMIN);
  await page.locator("#password").fill(known.password);
  await page.locator("#kc-login").click();
  await page.locator("#otp").waitFor({ state: "visible" });
  // Keycloak accepts each code once, so wait for a step after the last code used.
  const nextStep = (Math.floor(known.totpUsedAt / TOTP_STEP_MS) + 1) * TOTP_STEP_MS;
  if (Date.now() < nextStep) await page.waitForTimeout(nextStep - Date.now() + 500);
  const usedAt = Date.now();
  await page.locator("#otp").fill(totp(known.totpSecret, usedAt));
  await page.locator("#kc-login").click();
  saveSignedInFirstAdmin({ ...known, totpUsedAt: usedAt });
}

/** Toggles the app's sidebar when the page has one, so its sidebar cookie is written. */
async function toggleSidebar(page: Page): Promise<boolean> {
  const trigger = page.locator('[data-sidebar="trigger"]').first();
  if (!(await trigger.isVisible())) return false;
  await trigger.click();
  return true;
}

test("after signing in to Platform and Studio on one host, no cookie name is set by both apps", async ({ page }) => {
  const context = page.context();
  const written: Record<App, Set<string>> = { platform: new Set(), studio: new Set(), auth: new Set() };
  const record = (url: string, name: string) => {
    const app = appOf(url);
    if (app !== undefined && name !== "") written[app].add(name);
  };

  const pending: Promise<void>[] = [];
  const onResponse = (response: Response) => {
    pending.push(
      response.headersArray().then((headers) => {
        for (const header of headers) {
          if (header.name.toLowerCase() === "set-cookie") {
            for (const line of header.value.split("\n")) record(response.url(), cookieName(line));
          }
        }
      }),
    );
  };
  context.on("response", onResponse);
  // Cookies written by client code, such as the sidebar state, never pass through a response.
  await context.exposeBinding("__libredbCookieWritten", ({ frame }, name: string) => record(frame.url(), name));
  // A string, because the installer's TypeScript has no DOM types; it runs in every page before the page's own code.
  await context.addInitScript({ content: COOKIE_RECORDER });

  // Platform on its port: the first admin's first login, or its saved password and TOTP device after an earlier run.
  await page.goto(`${PLATFORM_URL}/login`);
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/protocol/openid-connect/auth"));
  expect(appOf(page.url())).toBe("auth");
  await signInOnKeycloak(page, PLATFORM_URL);
  await expect(page).toHaveURL((url) => url.origin === PLATFORM_URL && url.pathname !== "/login");
  await page.locator('[data-sidebar="trigger"]').first().waitFor({ state: "visible" });
  expect(await toggleSidebar(page)).toBe(true);

  // Studio on its port: Keycloak's session signs the admin in again, or asks for the password and a TOTP code.
  await page.goto(`${STUDIO_URL}/login`);
  await page.waitForURL((url) =>
    url.origin === STUDIO_URL ? url.pathname !== "/login" : url.pathname.endsWith("/protocol/openid-connect/auth"),
  );
  if (appOf(page.url()) === "auth") await signInOnKeycloak(page, STUDIO_URL);
  await expect(page).toHaveURL((url) => url.origin === STUDIO_URL && url.pathname !== "/login");
  await page.waitForLoadState("load");
  // Studio mounts no sidebar today; when it does, its toggle is recorded as well.
  await toggleSidebar(page);

  // A page keeps sending requests after the steps, so recording stops before the wait: a response recorded later
  // would read its headers while the context closes, and that rejection would fail the test after its last step.
  context.off("response", onResponse);
  await Promise.all(pending);
  expect(written.platform.size).toBeGreaterThan(0);
  expect(written.studio.size).toBeGreaterThan(0);
  expect(written.platform).toContain("libredb_platform_sidebar_state");
  const shared = (a: App, b: App) => [...written[a]].filter((name) => written[b].has(name)).sort();
  expect({
    "platform and studio": shared("platform", "studio"),
    "platform and keycloak": shared("platform", "auth"),
    "studio and keycloak": shared("studio", "auth"),
  }).toEqual({ "platform and studio": [], "platform and keycloak": [], "studio and keycloak": [] });
});
