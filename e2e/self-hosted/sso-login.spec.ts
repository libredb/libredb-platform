import { test, expect, type Page } from '@playwright/test'
import { Client } from 'pg'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// In self-hosted mode Platform signs in through Keycloak alone and admits only the admin role.
// The server runs with e2e/self-hosted/platform.env against the Keycloak and PostgreSQL of docker-compose.test.yml,
// and this process reads DATABASE_URL and STUDIO_PUBLIC_URL from the same environment.

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env`)
  return value
}

/** Counts the platform.users rows of a Keycloak user, connected as the runtime role of DATABASE_URL. */
async function countUsersByKeycloakId(keycloakId: string): Promise<number> {
  const url = new URL(required('DATABASE_URL'))
  // schema=platform tells Platform's tools the schema; the query names it itself.
  url.searchParams.delete('schema')
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  try {
    const result = await client.query<{ count: string }>(
      'SELECT count(*) FROM platform.users WHERE "keycloakId" = $1',
      [keycloakId],
    )
    return Number(result.rows[0].count)
  } finally {
    await client.end()
  }
}

/** Auth.js answers null on /api/auth/session when the browser holds no session. */
async function expectNoSession(page: Page): Promise<void> {
  const response = await page.request.get('/api/auth/session')
  expect(response.ok()).toBe(true)
  expect(await response.json()).toBeNull()
}

async function expectAccessDenied(page: Page): Promise<void> {
  await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('error') === 'AccessDenied')
  await expect(page.getByText('Platform requires the admin role')).toBeVisible()
  await expectNoSession(page)
}

test.describe('Keycloak sign-in in self-hosted mode', () => {
  test('alice signs in through Keycloak and lands on /connections', async ({ page, browser }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')
    const session = await (await page.request.get('/api/auth/session')).json()
    expect(session?.user?.email).toBe('alice@libredb.test')

    // A second sign-in, in a browser without the Keycloak session of the first, finds the same users row,
    // because the jwt callback upserts by keycloakId.
    const secondContext = await browser.newContext()
    try {
      const secondPage = await secondContext.newPage()
      await signInThroughKeycloak(secondPage, FIXTURE_USERS.alice)
      await expect(secondPage).toHaveURL(url => url.pathname === '/connections')
    } finally {
      await secondContext.close()
    }
    expect(await countUsersByKeycloakId(FIXTURE_USERS.alice.keycloakId)).toBe(1)
  })

  test('bob, who holds only user, is refused with AccessDenied and sees the Studio link', async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.bob)
    await expectAccessDenied(page)
    await expect(page.getByRole('link', { name: 'LibreDB Studio' })).toHaveAttribute('href', required('STUDIO_PUBLIC_URL'))
    expect(await countUsersByKeycloakId(FIXTURE_USERS.bob.keycloakId)).toBe(0)
  })

  test('carol, who holds no role, is refused', async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.carol)
    await expectAccessDenied(page)
    expect(await countUsersByKeycloakId(FIXTURE_USERS.carol.keycloakId)).toBe(0)
  })

  test("grace, an admin who never signed in, is refused while alice holds the license's one admin seat", async ({ page, browser }) => {
    // The license of the run, in PLATFORM_LICENSE, has 1 admin seat, which alice takes.
    const aliceContext = await browser.newContext()
    try {
      await signInThroughKeycloak(await aliceContext.newPage(), FIXTURE_USERS.alice)
    } finally {
      await aliceContext.close()
    }
    expect(await countUsersByKeycloakId(FIXTURE_USERS.alice.keycloakId)).toBe(1)
    expect(await countUsersByKeycloakId(FIXTURE_USERS.grace.keycloakId)).toBe(0)

    await signInThroughKeycloak(page, FIXTURE_USERS.grace)

    await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('error') === 'LICENSE_ADMIN_SEATS')
    await expect(page.getByText('Your first sign-in needs a free admin seat')).toBeVisible()
    await expect(page.getByText('Platform requires the admin role')).toHaveCount(0)
    await expectNoSession(page)
    expect(await countUsersByKeycloakId(FIXTURE_USERS.grace.keycloakId)).toBe(0)
  })

  test('the login page has no email or password field and /api/auth/providers lists only keycloak', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('button', { name: 'Continue with SSO' })).toBeVisible()
    await expect(page.locator('input[type="email"], input[name="email"]')).toHaveCount(0)
    await expect(page.locator('input[type="password"], input[name="password"]')).toHaveCount(0)

    const response = await page.request.get('/api/auth/providers')
    expect(response.ok()).toBe(true)
    expect(Object.keys(await response.json())).toEqual(['keycloak'])
  })
})
