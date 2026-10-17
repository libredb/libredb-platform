import { test, expect, type Page } from '@playwright/test'
import { listUserSessions } from './helpers/keycloak-admin'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// Logout ends the Platform session and the Keycloak session through the realm's end_session_endpoint.
// Without the second step the surviving Keycloak session signs the user straight back in, without the password form.
// Other specs sign alice in at the same time, so these tests follow the Keycloak session of their own browser only.

/** Signs out through the user menu and waits until Keycloak has sent the browser back to Platform's login page. */
async function signOutThroughUserMenu(page: Page): Promise<void> {
  const origin = new URL(page.url()).origin
  const signOut = page.getByRole('menuitem', { name: 'Sign out' })
  // A click before hydration opens no menu, so the trigger is clicked until the menu shows.
  await expect(async () => {
    if (!(await signOut.isVisible())) await page.getByText('alice@libredb.test').click()
    await expect(signOut).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await signOut.click()
  await page.waitForURL(url => url.origin === origin && url.pathname === '/login')
  await expect(page).toHaveURL(url => url.searchParams.get('error') === null)
}

/**
 * The id of the Keycloak session of this browser, the `sid` claim of the KEYCLOAK_IDENTITY cookie that Keycloak sets
 * at sign-in. Only the payload is read, which needs no key.
 */
async function keycloakSessionId(page: Page): Promise<string> {
  const issuer = process.env.AUTH_KEYCLOAK_ISSUER
  if (!issuer) throw new Error('AUTH_KEYCLOAK_ISSUER must be set for the self-hosted e2e suite')
  // Keycloak scopes the cookie to the realm path with a trailing slash, /realms/<realm>/.
  const cookies = await page.context().cookies(`${issuer.replace(/\/+$/, '')}/`)
  const identity = cookies.find(cookie => cookie.name === 'KEYCLOAK_IDENTITY')
  if (!identity) throw new Error('The browser holds no KEYCLOAK_IDENTITY cookie for the realm')
  const payload = JSON.parse(Buffer.from(identity.value.split('.')[1], 'base64url').toString('utf8')) as { sid?: string }
  if (!payload.sid) throw new Error('The KEYCLOAK_IDENTITY cookie carries no sid claim')
  return payload.sid
}

test.describe('Single logout through Keycloak in self-hosted mode', () => {
  test('after logout, opening /connections shows the Keycloak password form again', async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    await signOutThroughUserMenu(page)
    expect(await (await page.request.get('/api/auth/session')).json()).toBeNull()

    await page.goto('/connections')
    await expect(page).toHaveURL(url => url.pathname === '/login')
    await page.getByRole('button', { name: 'Continue with SSO' }).click()
    await page.waitForURL(url => url.pathname.endsWith('/protocol/openid-connect/auth'))
    await expect(page.locator('#password')).toBeVisible()
  })

  test('Keycloak holds no session for alice after logout', async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')
    const sessionId = await keycloakSessionId(page)
    const before = await listUserSessions(FIXTURE_USERS.alice.keycloakId)
    expect(before.map(session => session.id)).toContain(sessionId)

    await signOutThroughUserMenu(page)

    const after = await listUserSessions(FIXTURE_USERS.alice.keycloakId)
    expect(after.map(session => session.id)).not.toContain(sessionId)
  })
})
