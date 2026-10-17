// The first LibreDB admin signs in to Studio through the managed Keycloak: Studio keeps its server storage
// in schema studio of database libredb, keys the admin's rows by the Keycloak subject, and gives the session the
// 8-hour lifetime of AUTH_SESSION_TTL_SECONDS. It runs after platform-login.spec.ts or alone on a fresh installation.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { FIRST_ADMIN, firstAdminTemporaryPassword } from "./helpers/platform";
import { psqlAsSuperuser, signInToStudio, STUDIO_URL } from "./helpers/studio";

const SESSION_TTL_SECONDS = 28_800;

const account = () => ({
  username: FIRST_ADMIN,
  temporaryPassword: firstAdminTemporaryPassword(),
  newPassword: `E2e-${randomUUID()}`,
  email: "libredb-admin@libredb.test",
  firstName: "LibreDB",
  lastName: "Admin",
});

test("after the first admin signs in to Studio, to_regclass('studio.user_storage') is set, to_regclass('public.user_storage') is null, and the session cookie lasts 28800 s", async ({
  page,
}) => {
  await signInToStudio(page, account());
  const signedInAt = Date.now() / 1000;
  const cookie = (await page.context().cookies(STUDIO_URL)).find((candidate) => candidate.name === "auth-token");
  expect(cookie).toBeDefined();
  const lifetime = (cookie?.expires ?? 0) - signedInAt;
  expect(lifetime).toBeGreaterThan(SESSION_TTL_SECONDS - 120);
  expect(lifetime).toBeLessThanOrEqual(SESSION_TTL_SECONDS + 5);

  // Studio opens its storage provider, which creates its tables, on the first storage request, such as the read the
  // editor makes when it loads the user's collections.
  const status = await page.evaluate(async () => (await fetch("/api/storage")).status);
  expect(status).toBe(200);
  expect(psqlAsSuperuser("libredb", "SELECT coalesce(to_regclass('studio.user_storage')::text, 'null')")).toBe(
    "studio.user_storage",
  );
  expect(psqlAsSuperuser("libredb", "SELECT coalesce(to_regclass('public.user_storage')::text, 'null')")).toBe("null");
});

test("the first admin's rows in studio.user_storage are keyed sub: followed by their Keycloak user id", async ({ page }) => {
  await signInToStudio(page, account());
  // A write through Studio's own storage route, as the editor makes when it saves a query.
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/storage/saved_queries", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: [] }),
    });
    return response.status;
  });
  expect(status).toBe(200);

  const userId = psqlAsSuperuser(
    "keycloak",
    `SELECT u.id FROM user_entity u JOIN realm r ON r.id = u.realm_id WHERE r.name = 'libredb' AND u.username = '${FIRST_ADMIN}'`,
  );
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  const owners = psqlAsSuperuser("libredb", "SELECT string_agg(DISTINCT user_id, ',') FROM studio.user_storage");
  expect(owners).toBe(`sub:${userId}`);
});
