import { test, expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test'
import { decode } from 'next-auth/jwt'
import { assignLibredbRole, endSession, removeLibredbRole } from './helpers/keycloak-admin'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// Every PLATFORM_SESSION_RECHECK_SECONDS, which e2e/self-hosted/platform.env sets to 2, the proxy asks
// the Keycloak directory whether a Platform session still stands, writes the rechecked token back to the browser, and
// sends a session that a recheck ended to /login.
// Removing alice's role ends every session of hers, so the self-hosted project runs one test at a time.

/** The cookie of the Auth.js session token on http, which is also the salt of its encryption. */
const SESSION_COOKIE = 'authjs.session-token'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env`)
  return value
}

/** Waits one second longer than the recheck interval, so that the next request of any session is due for a recheck. */
async function waitForRecheck(): Promise<void> {
  const interval = Number(required('PLATFORM_SESSION_RECHECK_SECONDS'))
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error('PLATFORM_SESSION_RECHECK_SECONDS must be a positive integer')
  }
  await new Promise(resolve => setTimeout(resolve, (interval + 1) * 1000))
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

interface RecheckState {
  checkedAt: number
  recheckAttemptedAt: number
  directoryDegraded: boolean
}

/** The recheck fields of the session token in the browser's cookie jar, decrypted with AUTH_SECRET. */
async function recheckState(context: BrowserContext): Promise<RecheckState> {
  // Auth.js splits a token longer than one cookie into SESSION_COOKIE.0, .1 and so on.
  const chunks = (await context.cookies())
    .filter(cookie => cookie.name === SESSION_COOKIE || cookie.name.startsWith(`${SESSION_COOKIE}.`))
    .sort((a, b) => Number(a.name.split('.').at(-1)) - Number(b.name.split('.').at(-1)))
  if (chunks.length === 0) throw new Error('The browser holds no Platform session cookie')
  const token = await decode({
    token: chunks.map(chunk => chunk.value).join(''),
    secret: required('AUTH_SECRET'),
    salt: SESSION_COOKIE,
  })
  const { checkedAt, recheckAttemptedAt, directoryDegraded } = token ?? {}
  if (typeof checkedAt !== 'number' || typeof recheckAttemptedAt !== 'number' || typeof directoryDegraded !== 'boolean') {
    throw new Error('The Platform session token carries no recheck fields')
  }
  return { checkedAt, recheckAttemptedAt, directoryDegraded }
}

function setsSessionCookie(response: APIResponse): boolean {
  return response
    .headersArray()
    .some(header => header.name.toLowerCase() === 'set-cookie' && header.value.startsWith(SESSION_COOKIE))
}

/** Navigates to /connections and expects the proxy to send the browser to /login, with no session left. */
async function expectSentToLogin(page: Page): Promise<void> {
  await page.goto('/connections')
  await expect(page).toHaveURL(
    url => url.pathname === '/login' && url.searchParams.get('callbackUrl') === '/connections',
  )
  expect(await (await page.request.get('/api/auth/session')).json()).toBeNull()
}

test.describe('Session recheck in self-hosted mode', () => {
  test("removing alice's admin role sends her to /login on her next navigation", async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    await removeLibredbRole(FIXTURE_USERS.alice.keycloakId, 'admin')
    try {
      await waitForRecheck()
      await expectSentToLogin(page)
    } finally {
      await assignLibredbRole(FIXTURE_USERS.alice.keycloakId, 'admin')
    }
  })

  test("ending alice's Keycloak session through the Admin API sends her to /login", async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    await endSession(await keycloakSessionId(page))
    await waitForRecheck()
    await expectSentToLogin(page)
  })

  test('a request after the interval writes the rechecked session token back to the browser', async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')
    // The dashboard fetches the session and polls in the background, which writes the token back as well.
    await page.goto('about:blank')
    const before = await recheckState(page.context())

    await waitForRecheck()
    const response = await page.request.get('/connections', { maxRedirects: 0 })

    expect(response.status()).toBe(200)
    expect(setsSessionCookie(response)).toBe(true)
    const after = await recheckState(page.context())
    expect(after.recheckAttemptedAt).toBeGreaterThan(before.recheckAttemptedAt)
    expect(after.checkedAt).toBe(after.recheckAttemptedAt)
    expect(after.directoryDegraded).toBe(false)
  })
})
