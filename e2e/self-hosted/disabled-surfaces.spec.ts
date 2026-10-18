import { test, expect } from '@playwright/test'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// Self-hosted mode turns off registration, password reset, billing, team and invitations, and tenant, user and
// plan administration, so their pages answer 404 even for the admin.

const CLOUD_ONLY_PATHS = [
  '/register',
  '/forgot-password',
  '/billing',
  '/team',
  '/team/invitations',
  '/admin/tenants',
  '/admin/tenants/new',
  '/admin/tenants/00000000-0000-4000-8000-000000000000',
  '/admin/users',
  '/admin/plans',
]

test.describe('Cloud-only pages in self-hosted mode', () => {
  test('/register, /forgot-password, /billing, /team, /team/invitations, /admin/tenants, /admin/users and /admin/plans answer 404 for alice', async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    for (const path of CLOUD_ONLY_PATHS) {
      const response = await page.goto(path)
      expect(response?.status(), path).toBe(404)
      await expect(page, path).toHaveURL(url => url.pathname === path)
    }
  })
})
