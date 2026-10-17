import { test, expect, type Page } from '@playwright/test'
import { getRealmSessionSettings, listUserSessions, updateRealmSessionSettings } from './helpers/keycloak-admin'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// Platform keeps the Keycloak session of an active admin alive, because the realm's SSO Session Idle
// is the site's to choose. Every PLATFORM_SESSION_RECHECK_SECONDS, which e2e/self-hosted/platform.env sets to 2, a
// request rechecks the Platform session and first refreshes its Keycloak session, which resets the idle timer.
// The spec shortens SSO Session Idle on the fixture realm and restores it however it ends.

/** The SSO Session Idle that the spec gives the fixture realm, in seconds. */
const SSO_SESSION_IDLE_SECONDS = 15
/** The pause between two navigations of the active admin, well within the recheck interval and the idle limit. */
const NAVIGATION_PAUSE_MS = 1_000
/**
 * How long after SSO Session Idle the spec waits at most for Keycloak to drop the idle admin's session: Keycloak 26.8.1
 * drops it at the limit, and versions that keep an expired session for a cleanup window keep it up to 180 s longer.
 */
const SESSION_DROP_WINDOW_MS = 180_000

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env`)
  return value
}

/**
 * The id of the Keycloak session of this browser, the `sid` claim of the KEYCLOAK_IDENTITY cookie that Keycloak sets
 * at sign-in, which is also the `sid` of the ID token. Only the payload is read, which needs no key.
 */
async function keycloakSessionId(page: Page): Promise<string> {
  // Keycloak scopes the cookie to the realm path with a trailing slash, /realms/<realm>/.
  const cookies = await page.context().cookies(`${required('AUTH_KEYCLOAK_ISSUER').replace(/\/+$/, '')}/`)
  const identity = cookies.find(cookie => cookie.name === 'KEYCLOAK_IDENTITY')
  if (!identity) throw new Error('The browser holds no KEYCLOAK_IDENTITY cookie for the realm')
  const payload = JSON.parse(Buffer.from(identity.value.split('.')[1], 'base64url').toString('utf8')) as { sid?: string }
  if (!payload.sid) throw new Error('The KEYCLOAK_IDENTITY cookie carries no sid claim')
  return payload.sid
}

/** The ids of alice's Keycloak sessions that the realm still lists. */
async function aliceSessionIds(): Promise<string[]> {
  return (await listUserSessions(FIXTURE_USERS.alice.keycloakId)).map(session => session.id)
}

test.describe('Keycloak session keepalive in self-hosted mode', () => {
  test('with a short SSO Session Idle on the fixture realm, an admin who keeps navigating is still signed in after the idle limit has passed', async ({ page, browser }) => {
    test.setTimeout(SSO_SESSION_IDLE_SECONDS * 1000 + SESSION_DROP_WINDOW_MS + 60_000)
    const original = await getRealmSessionSettings()
    await updateRealmSessionSettings({ ssoSessionIdleTimeout: SSO_SESSION_IDLE_SECONDS })
    const idleContext = await browser.newContext()
    try {
      // The active admin signs in first, so Keycloak would drop her session no later than the idle admin's one if
      // nothing refreshed it.
      await signInThroughKeycloak(page, FIXTURE_USERS.alice)
      await expect(page).toHaveURL(url => url.pathname === '/connections')
      const activeSessionId = await keycloakSessionId(page)

      // A second session of alice sends no request after its sign-in: about:blank also stops the dashboard's polling.
      const idlePage = await idleContext.newPage()
      await signInThroughKeycloak(idlePage, FIXTURE_USERS.alice)
      const idleSince = Date.now()
      await expect(idlePage).toHaveURL(url => url.pathname === '/connections')
      const idleSessionId = await keycloakSessionId(idlePage)
      await idlePage.goto('about:blank')

      // Keycloak may expire an idle session only some time after SSO Session Idle, so the spec measures that delay: the
      // active admin keeps navigating until Keycloak no longer lists the idle session.
      while ((await aliceSessionIds()).includes(idleSessionId)) {
        if (Date.now() - idleSince > SSO_SESSION_IDLE_SECONDS * 1000 + SESSION_DROP_WINDOW_MS) {
          throw new Error('Keycloak still lists the idle session long after its SSO Session Idle')
        }
        await page.goto('/connections')
        await expect(page).toHaveURL(url => url.pathname === '/connections')
        await new Promise(resolve => setTimeout(resolve, NAVIGATION_PAUSE_MS))
      }
      // Keycloak dropped the idle session for its idle limit, which it counts in whole seconds.
      expect(Date.now() - idleSince).toBeGreaterThanOrEqual((SSO_SESSION_IDLE_SECONDS - 1) * 1000)

      // The active admin is past the same limit and delay, still signed in, and Keycloak still has her session.
      await page.goto('/connections')
      await expect(page).toHaveURL(url => url.pathname === '/connections')
      expect(await (await page.request.get('/api/auth/session')).json()).toMatchObject({ authProvider: 'keycloak' })
      expect(await aliceSessionIds()).toContain(activeSessionId)

      // The idle admin's next request finds her Keycloak session gone, and the recheck sends her to /login.
      await idlePage.goto('/connections')
      await expect(idlePage).toHaveURL(url => url.pathname === '/login')
    } finally {
      await idleContext.close()
      await updateRealmSessionSettings({ ssoSessionIdleTimeout: original.ssoSessionIdleTimeout })
    }
  })
})
