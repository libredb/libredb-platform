import { test, expect } from '@playwright/test'
import { adminCredentials } from './credentials'

test.describe('Login page', () => {
  test('renders Control Tower hero on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/login')

    await expect(page.getByText('Authorize.', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Audit.', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Govern.', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/GOVERNANCE LAYER/i)).toBeVisible()
    // Topology left column is roles (not other tenants), so the tenant sees
    // "my team / my governance / my databases".
    await expect(page.getByText('Admin', { exact: true })).toBeVisible()
    await expect(page.getByText('Editor', { exact: true })).toBeVisible()
    await expect(page.getByText('Viewer', { exact: true })).toBeVisible()
    // Supported engines strip replaces the old queries counter.
    await expect(page.getByText(/Works Across Your Stack/i)).toBeVisible()
    await expect(page.getByText('PostgreSQL')).toBeVisible()
    await expect(page.getByText('MongoDB')).toBeVisible()
    await expect(page.getByText('Redis')).toBeVisible()
  })

  test('does not leak cross-tenant, per-user, or aggregate activity data', async ({ page }) => {
    // Three guards, all reasons the original hero was reshaped:
    //   1. No live audit stream (looks like leaked customer activity)
    //   2. No other tenant names (breaks multi-tenant isolation promise)
    //   3. No platform-wide queries counter (aggregate-leak / framing risk)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/login')

    await expect(page.getByText(/LIVE AUDIT STREAM/i)).toHaveCount(0)
    await expect(page.getByText(/blocked by RBAC/i)).toHaveCount(0)
    await expect(page.getByText(/pending approval/i)).toHaveCount(0)
    await expect(page.getByText(/Acme Corp/i)).toHaveCount(0)
    await expect(page.getByText(/Finch Labs/i)).toHaveCount(0)
    await expect(page.getByText(/Orbit Inc/i)).toHaveCount(0)
    await expect(page.getByText(/queries governed today/i)).toHaveCount(0)
  })

  test('hides the hero on mobile; shows form', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/login')

    // Desktop-only hero elements should not be visible on mobile
    await expect(page.getByText(/GOVERNANCE LAYER/i)).toBeHidden()
    // Form still present
    await expect(page.getByRole('button', { name: /^Sign in$/i })).toBeVisible()
  })

  test('does not show dev credentials card even in dev mode', async ({ page }) => {
    const admin = adminCredentials()
    await page.goto('/login')
    await expect(page.getByText(/Development Credentials/i)).toHaveCount(0)
    await expect(page.getByText(admin.email)).toHaveCount(0)
    await expect(page.getByText(admin.password)).toHaveCount(0)
  })

  test('submits credentials and fails gracefully on bad creds', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel(/email/i).fill('nobody@example.com')
    await page.getByLabel(/password/i).fill('wrong-password')
    await page.getByRole('button', { name: /^Sign in$/i }).click()
    await expect(page.getByText('Invalid email or password')).toBeVisible()
  })
})
