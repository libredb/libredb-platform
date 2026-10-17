// The first LibreDB admin of a fresh installation signs in to Platform through the managed Keycloak:
// Keycloak makes the account set a new password, a TOTP device and its profile, and Platform admits it, because it
// holds the client role libredb:admin. It needs an installation whose first admin has not signed in yet.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { FIRST_ADMIN, firstAdminTemporaryPassword, firstLoginToPlatform } from "./helpers/platform";

test("the first admin signs in to Platform through Keycloak, sets a password and TOTP, and reaches /connections", async ({ page }) => {
  const account = {
    username: FIRST_ADMIN,
    temporaryPassword: firstAdminTemporaryPassword(),
    newPassword: `E2e-${randomUUID()}`,
    email: "libredb-admin@libredb.test",
    firstName: "LibreDB",
    lastName: "Admin",
  };
  const { completed, totpSecret } = await firstLoginToPlatform(page, account);
  expect(completed).toEqual(expect.arrayContaining(["password", "totp"]));
  expect(totpSecret).toMatch(/^[A-Z2-7]+$/);

  await expect(page).toHaveURL((url) => url.pathname === "/connections");
  // Asked from the page, which resolves the hostnames and holds the session cookie as the browser does.
  const session = await page.evaluate(
    async () => (await fetch("/api/auth/session")).json() as Promise<{ user?: { email?: string } } | null>,
  );
  expect(session?.user?.email).toBe(account.email);
});
