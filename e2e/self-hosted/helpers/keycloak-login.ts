import type { Page } from '@playwright/test'

// The fixture users of tests/fixtures/keycloak/libredb-test-realm.json that the self-hosted suite signs in with.
// Their ids are fixed in the realm file, so a test can find the platform.users row of a user by its keycloakId.
export const FIXTURE_USERS = {
  /** Holds the client role libredb:admin directly. */
  alice: { username: 'alice', keycloakId: '00000000-0000-4000-8000-00000000a11c' },
  /** Holds the client role libredb:admin through the group dba. */
  grace: { username: 'grace', keycloakId: '00000000-0000-4000-8000-000000009ace' },
  /** Holds only the client role libredb:user. */
  bob: { username: 'bob', keycloakId: '00000000-0000-4000-8000-000000000b0b' },
  /** Holds no libredb role. */
  carol: { username: 'carol', keycloakId: '00000000-0000-4000-8000-00000000ca20' },
} as const

export type FixtureUser = (typeof FIXTURE_USERS)[keyof typeof FIXTURE_USERS]

/** The password of every fixture user. */
const FIXTURE_PASSWORD = 'libredb-test-password'

/**
 * Signs a fixture user in through the Keycloak login form: starts the sign-in from Platform's login page, submits the
 * user's credentials on Keycloak's form, and returns once the browser is back on Platform.
 * The page must have no Keycloak session yet, otherwise Keycloak skips its form.
 */
export async function signInThroughKeycloak(page: Page, user: FixtureUser): Promise<void> {
  await page.goto('/login')
  const platformOrigin = new URL(page.url()).origin
  await page.getByRole('button', { name: 'Continue with SSO' }).click()

  await page.waitForURL(url => url.pathname.endsWith('/protocol/openid-connect/auth'))
  await page.locator('#username').fill(user.username)
  await page.locator('#password').fill(FIXTURE_PASSWORD)
  await page.locator('#kc-login').click()

  await page.waitForURL(url => url.origin === platformOrigin)
}
