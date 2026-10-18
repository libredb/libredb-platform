// Drives Platform's sign-in through the managed Keycloak of an installation, including the first login of an account
// the installer created, for which Keycloak asks a new password, a TOTP device and the profile fields the account was
// created without, in whatever order it chooses. TOTP codes come from the secret Keycloak shows on its setup page.
// It also drives the admin pages of Platform that the interop suite uses: connections, grants, Studio users and
// Studio settings.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, type Response } from "@playwright/test";

/** keycloak.firstAdmin.username of test/fixtures/configs/docker.yaml, the default. */
export const FIRST_ADMIN = "libredb-admin";

/** The first admin's temporary password: LIBREDB_E2E_FIRST_ADMIN_PASSWORD_FILE, or the file the installer writes. */
export function firstAdminTemporaryPassword(): string {
  const file = process.env.LIBREDB_E2E_FIRST_ADMIN_PASSWORD_FILE ?? "/opt/libredb/secrets/first-admin.txt";
  return readFileSync(file, "utf8").trim();
}

/** The first admin's own password and TOTP secret once a spec completed its first login, shared by later specs. */
export interface SignedInAccount {
  password: string;
  totpSecret: string;
  /** When a TOTP code was last used, in epoch milliseconds; Keycloak refuses a code twice. */
  totpUsedAt: number;
}

/** LIBREDB_E2E_ACCOUNT_FILE, or a file in the temporary directory, which the specs of one run share. */
function accountFile(): string {
  return process.env.LIBREDB_E2E_ACCOUNT_FILE ?? join(tmpdir(), "libredb-e2e-first-admin.json");
}

/** The first admin as an earlier spec of this installation left it, or undefined before its first login. */
export function signedInFirstAdmin(): SignedInAccount | undefined {
  const file = accountFile();
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SignedInAccount) : undefined;
}

export function saveSignedInFirstAdmin(account: SignedInAccount): void {
  writeFileSync(accountFile(), JSON.stringify(account), { mode: 0o600 });
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text: string): Buffer {
  let bits = "";
  for (const char of text.toUpperCase().replace(/=+$/, "")) {
    const value = BASE32.indexOf(char);
    if (value === -1) throw new Error(`not a base32 character: ${char}`);
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}

/** The RFC 6238 code of a base32 secret: HMAC-SHA1, 30-second steps and 6 digits, Keycloak's default OTP policy. */
export function totp(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (digest.at(-1) as number) & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

export interface FirstLogin {
  username: string;
  temporaryPassword: string;
  newPassword: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** A required action page of Keycloak's login theme, or the app once the sign-in is done. */
export type Stage = "platform" | "password" | "totp" | "profile";

// The form field that identifies each required action page of Keycloak's login theme.
const STAGE_FIELDS: readonly (readonly [Stage, string])[] = [
  ["password", "#password-new"],
  ["totp", "#totp"],
  ["profile", "#email"],
];

async function visibleStage(page: Page, appOrigin: string): Promise<Stage | undefined> {
  if (new URL(page.url()).origin === appOrigin) return "platform";
  for (const [stage, field] of STAGE_FIELDS) {
    if (await page.locator(field).isVisible()) return stage;
  }
  return undefined;
}

/** Waits until the browser is back on the app or shows a required action page, and names it. */
async function nextStage(page: Page, appOrigin: string): Promise<Stage> {
  let stage: Stage | undefined;
  await expect
    .poll(async () => (stage = await visibleStage(page, appOrigin)), {
      timeout: 30_000,
      message: `Keycloak showed neither a required action nor a redirect to the app at ${page.url()}`,
    })
    .toBeDefined();
  return stage as Stage;
}

/** Submits the current form and waits until the page that held `field` is gone. */
async function submit(page: Page, field: string, button = page.getByRole("button", { name: "Submit" })): Promise<void> {
  await button.click();
  await page.locator(field).waitFor({ state: "detached" });
}

/**
 * Signs in on Keycloak's form, which the browser shows, with the temporary password and completes every required
 * action until the browser is back on the app at `appOrigin`. Returns the actions it completed, in order, and the
 * TOTP secret Keycloak issued, and saves the account for the specs that sign in after it.
 */
export async function completeFirstLogin(
  page: Page,
  appOrigin: string,
  account: FirstLogin,
): Promise<{ completed: Stage[]; totpSecret: string }> {
  await page.locator("#username").fill(account.username);
  await page.locator("#password").fill(account.temporaryPassword);
  await page.locator("#kc-login").click();

  let totpSecret: string | undefined;
  let totpUsedAt = 0;
  const completed: Stage[] = [];
  for (;;) {
    const stage = await nextStage(page, appOrigin);
    if (stage === "platform") break;
    if (completed.includes(stage)) {
      throw new Error(`Keycloak asked for the ${stage} action again: ${await page.locator("body").innerText()}`);
    }
    completed.push(stage);
    if (stage === "password") {
      await page.locator("#password-new").fill(account.newPassword);
      await page.locator("#password-confirm").fill(account.newPassword);
      await submit(page, "#password-new");
    } else if (stage === "totp") {
      await page.locator("#mode-manual").click();
      totpSecret = (await page.locator("#kc-totp-secret-key").innerText()).replaceAll(/\s/g, "");
      totpUsedAt = Date.now();
      await page.locator("#totp").fill(totp(totpSecret, totpUsedAt));
      await submit(page, "#totp", page.locator("#saveTOTPBtn"));
    } else {
      await page.locator("#email").fill(account.email);
      await page.locator("#firstName").fill(account.firstName);
      await page.locator("#lastName").fill(account.lastName);
      await submit(page, "#email");
    }
  }
  if (totpSecret === undefined) throw new Error("Keycloak never asked the first login for a TOTP device");
  saveSignedInFirstAdmin({ password: account.newPassword, totpSecret, totpUsedAt });
  return { completed, totpSecret };
}

/**
 * Starts the sign-in on Platform's login page, signs in on Keycloak's form with the temporary password and completes
 * every required action until the browser is back on Platform. Returns the actions it completed, in order, and the
 * TOTP secret Keycloak issued.
 */
export async function firstLoginToPlatform(
  page: Page,
  account: FirstLogin,
): Promise<{ completed: Stage[]; totpSecret: string }> {
  await page.goto("/login");
  const platformOrigin = new URL(page.url()).origin;
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/protocol/openid-connect/auth"));
  return completeFirstLogin(page, platformOrigin, account);
}

const TOTP_STEP_MS = 30_000;

/**
 * Signs the first admin in to Platform on Keycloak's form and waits until the browser is on a Platform page past the
 * sign-in: with the first login of `account` when no earlier spec of the run signed the first admin in, or else with
 * the password and TOTP device that first login set. Keycloak accepts each TOTP code once, so it waits for a code
 * after the last one used.
 */
export async function signInFirstAdminToPlatform(page: Page, account: FirstLogin): Promise<void> {
  await page.goto("/login");
  const platformOrigin = new URL(page.url()).origin;
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/protocol/openid-connect/auth"));
  const known = signedInFirstAdmin();
  if (known === undefined) {
    await completeFirstLogin(page, platformOrigin, account);
  } else {
    await page.locator("#username").fill(account.username);
    await page.locator("#password").fill(known.password);
    await page.locator("#kc-login").click();
    await page.locator("#otp").waitFor({ state: "visible" });
    const nextStep = (Math.floor(known.totpUsedAt / TOTP_STEP_MS) + 1) * TOTP_STEP_MS;
    if (Date.now() < nextStep) await page.waitForTimeout(nextStep - Date.now() + 500);
    const usedAt = Date.now();
    await page.locator("#otp").fill(totp(known.totpSecret, usedAt));
    await page.locator("#kc-login").click();
    saveSignedInFirstAdmin({ ...known, totpUsedAt: usedAt });
  }
  // A refused sign-in also ends on Platform, on /login with the code of its refusal.
  await expect(page).toHaveURL((url) => url.origin === platformOrigin && url.pathname !== "/login", {
    timeout: 30_000,
  });
}

/** A Keycloak user who signs in with a password alone, such as one a spec created through the Admin API. */
export interface PasswordUser {
  username: string;
  password: string;
}

/**
 * The response of the next server action the page posts whose JSON arguments contain `marker`. Next.js posts a
 * server action to the page's own URL with a Next-Action header and answers once the action has run, so the response
 * marks the moment Platform's change is committed.
 */
function nextServerAction(page: Page, marker: string): Promise<Response> {
  return page.waitForResponse(async (response) => {
    const request = response.request();
    if (request.method() !== "POST" || (await request.headerValue("next-action")) === null) return false;
    return (request.postData() ?? "").includes(marker);
  });
}

/** Runs `click` and returns the server action response that `marker` identifies, with the time it arrived. */
async function runServerAction(
  page: Page,
  marker: string,
  click: () => Promise<void>,
): Promise<{ response: Response; answeredAt: number }> {
  const action = nextServerAction(page, marker);
  await click();
  const response = await action;
  const answeredAt = Date.now();
  expect(response.status(), `the server action that posted ${marker}`).toBe(200);
  return { response, answeredAt };
}

/** A database credential as Platform's connection form takes it. */
export interface Credential {
  user: string;
  password: string;
}

/** A PostgreSQL connection as the interop suite creates it: a database on a host that Studio reaches without TLS. */
export interface PostgresConnection {
  name: string;
  host: string;
  port: number;
  database: string;
  read: Credential;
  write?: Credential;
}

/**
 * Creates a PostgreSQL connection through Platform's connection form, which seals each credential to Studio's key,
 * and returns the time the create action answered, once Platform lists the connections again.
 */
export async function createConnection(page: Page, connection: PostgresConnection): Promise<{ answeredAt: number }> {
  await page.goto("/connections/new");
  await page.getByLabel("Name", { exact: true }).fill(connection.name);
  await page.getByLabel("Engine", { exact: true }).selectOption("postgres");
  await page.getByLabel("Host", { exact: true }).fill(connection.host);
  await page.getByLabel("Port", { exact: true }).fill(String(connection.port));
  await page.getByLabel("Database", { exact: true }).fill(connection.database);
  await page.getByLabel("SSL mode", { exact: true }).selectOption("disable");

  const read = page.getByRole("group", { name: "Read credential" });
  await read.getByLabel("User", { exact: true }).fill(connection.read.user);
  await read.getByLabel("Password", { exact: true }).fill(connection.read.password);
  await page.getByLabel(/I confirm that the read credential can only read/).check();
  if (connection.write !== undefined) {
    await page.getByLabel("Write credential", { exact: true }).selectOption("set");
    const write = page.getByRole("group", { name: "New write credential" });
    await write.getByLabel("User", { exact: true }).fill(connection.write.user);
    await write.getByLabel("Password", { exact: true }).fill(connection.write.password);
  }

  const { answeredAt } = await runServerAction(page, '"readOnlyConfirmed"', () =>
    page.getByRole("button", { name: "Create connection" }).click(),
  );
  await expect(page).toHaveURL((url) => url.pathname === "/connections");
  return { answeredAt };
}

/**
 * Deletes a connection with the trash button of its row in Platform's list and the dialog's Delete, as an admin does,
 * and returns once the list no longer shows it. Platform deletes it softly with its grants, so bridge.connections_v1
 * drops it and none of its envelopes stays sealed to a Studio key. The specs share one installation, so a spec deletes
 * the connection it created when it ends, and a later spec finds only connections of its own.
 */
export async function deleteConnection(page: Page, connection: { id: string; name: string }): Promise<void> {
  await page.goto("/connections");
  const row = page.locator("tbody tr").filter({ hasText: connection.name });
  await row.locator("button").click();
  await runServerAction(page, `"${connection.id}"`, () =>
    page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
  );
  await expect(row).toHaveCount(0);
}

/** Opens the page of the connection named `name` from Platform's list and returns its id. */
export async function openConnection(page: Page, name: string): Promise<string> {
  await page.goto("/connections");
  // A clickable row of the data table has the role button, so the row is found by its element.
  await page.locator("tbody tr").filter({ hasText: name }).getByText(name, { exact: true }).click();
  await expect(page).toHaveURL((url) => /^\/connections\/[^/]+$/.test(url.pathname));
  return new URL(page.url()).pathname.split("/").pop() as string;
}

export type GrantLevel = "read" | "write";

const LEVEL_LABELS: Record<GrantLevel, string> = { read: "Read", write: "Write" };

/** The access panel of the connection page that `page` shows. */
function accessPanel(page: Page) {
  return page.getByRole("region", { name: "Access" });
}

/** The row of the access panel that holds the grant of `username`. */
function grantRow(page: Page, username: string) {
  return accessPanel(page).getByRole("row", { name: new RegExp(`\\b${username}\\b`) });
}

/**
 * Grants `username`, picked from the Keycloak directory in the grant dialog, `level` on the connection page that
 * `page` shows, and returns the time the grant action answered.
 */
export async function grantAccess(page: Page, username: string, level: GrantLevel): Promise<{ answeredAt: number }> {
  await accessPanel(page).getByRole("button", { name: "Grant access" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("searchbox", { name: "Search the directory" }).fill(username);
  await dialog.getByRole("button", { name: "Search" }).click();
  const option = dialog.getByRole("radio", { name: new RegExp(`\\b${username}\\b`) });
  await expect(option).toHaveCount(1);
  await option.check();
  await dialog.getByRole("radio", { name: LEVEL_LABELS[level], exact: true }).check();
  const { answeredAt } = await runServerAction(page, `"level":"${level}"`, () =>
    dialog.getByRole("button", { name: "Grant", exact: true }).click(),
  );
  await expect(dialog).toHaveCount(0);
  await expect(grantRow(page, username)).toContainText(LEVEL_LABELS[level]);
  return { answeredAt };
}

/** Changes the level of the grant of `username` on the connection page that `page` shows. */
export async function changeGrantLevel(
  page: Page,
  username: string,
  level: GrantLevel,
): Promise<{ answeredAt: number }> {
  await grantRow(page, username).getByRole("button", { name: "Change" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: LEVEL_LABELS[level], exact: true }).check();
  const { answeredAt } = await runServerAction(page, `"level":"${level}"`, () =>
    dialog.getByRole("button", { name: "Save", exact: true }).click(),
  );
  await expect(dialog).toHaveCount(0);
  await expect(grantRow(page, username)).toContainText(LEVEL_LABELS[level]);
  return { answeredAt };
}

/**
 * Revokes the grant of `username` on the connection page that `page` shows and returns as soon as the action answered,
 * so a caller can measure from that moment; `grantRemoved` then checks the page.
 */
export async function revokeGrant(page: Page, username: string): Promise<{ answeredAt: number }> {
  await grantRow(page, username).getByRole("button", { name: "Revoke" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText(`Revoke the access of ${username}?`);
  const { answeredAt } = await runServerAction(page, '"grantId"', () =>
    confirm.getByRole("button", { name: "Revoke access" }).click(),
  );
  return { answeredAt };
}

/** Waits until the access panel of the connection page that `page` shows no longer lists a grant of `username`. */
export async function grantRemoved(page: Page, username: string): Promise<void> {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(grantRow(page, username)).toHaveCount(0);
}

/**
 * Revokes the Studio sessions of the Keycloak user `username`, whose id is `subject`, on Platform's Studio users page,
 * and returns as soon as the action answered, so a caller can measure from that moment.
 */
export async function revokeStudioSessions(
  page: Page,
  username: string,
  subject: string,
): Promise<{ answeredAt: number }> {
  await page.goto(`/studio-users?q=${encodeURIComponent(username)}`);
  const row = page.getByRole("table").getByRole("row", { name: new RegExp(`\\b${username}\\b`) });
  await row.getByRole("button", { name: "Revoke Studio sessions" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Revoke the Studio sessions of ${username}?`);
  const { answeredAt } = await runServerAction(page, `"subject":"${subject}"`, () =>
    dialog.getByRole("button", { name: "Revoke sessions" }).click(),
  );
  return { answeredAt };
}

/** The value Platform's Studio settings page shows for `key`: its value, or "Studio default" when it has none. */
export async function studioSettingValue(page: Page, key: string): Promise<string> {
  await page.goto("/studio-settings");
  return (await page.getByRole("group", { name: key }).getByTestId("current-value").innerText()).trim();
}

/** Saves `value` for the setting `key`, whose allowed values Platform offers in a select, and waits until it shows. */
export async function setStudioSetting(page: Page, key: string, value: string): Promise<{ answeredAt: number }> {
  await page.goto("/studio-settings");
  const row = page.getByRole("group", { name: key });
  await row.getByRole("combobox", { name: key }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
  const { answeredAt } = await runServerAction(page, `"key":"${key}"`, () =>
    row.getByRole("button", { name: `Save ${key}` }).click(),
  );
  await expect(row.getByTestId("current-value")).toHaveText(value);
  return { answeredAt };
}
