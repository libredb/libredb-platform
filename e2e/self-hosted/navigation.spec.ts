import { test, expect } from '@playwright/test'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// Self-hosted mode has no billing, team, tenant, user or plan administration, no tenant switching, and no
// registration or password reset.

test.describe('Navigation in self-hosted mode', () => {
  test('the sidebar has no Billing or Team entry for alice', async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    const sidebar = page.locator('[data-sidebar="sidebar"]')
    await expect(sidebar.getByRole('link', { name: 'Connections' })).toBeVisible()
    for (const name of ['Billing', 'Team', 'Tenants', 'Users', 'Plans']) {
      await expect(sidebar.getByRole('link', { name, exact: true })).toHaveCount(0)
    }

    // The install tenant is shown without a menu to switch tenants.
    await expect(sidebar.getByText('LibreDB-E2E')).toBeVisible()
    await expect(sidebar.locator('[aria-haspopup="menu"]').filter({ hasText: 'LibreDB-E2E' })).toHaveCount(0)
  })

  test('/register and /forgot-password send a visitor without a session to the login page', async ({ page }) => {
    for (const path of ['/register', '/forgot-password']) {
      await page.goto(path)
      await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('callbackUrl') === path)
    }
  })
})
