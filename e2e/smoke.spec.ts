import { test, expect } from '@playwright/test'
import { adminCredentials, seedUserCredentials } from './credentials'

test.describe('LibreDB Platform Smoke Tests', () => {

  test('1. Login page loads', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Password')).toBeVisible()
  })

  test('2. the platform admin lands on /connections after signing in', async ({ page }) => {
    const admin = adminCredentials()
    await page.goto('/login')
    await page.getByLabel('Email').fill(admin.email)
    await page.getByLabel('Password').fill(admin.password)
    await page.getByRole('button', { name: /sign in/i }).click()

    await page.waitForURL(/\/connections/, { timeout: 10000 })
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('3. Register new user and auto-login', async ({ page }) => {
    const unique = Date.now()
    await page.goto('/register')
    await expect(page.getByRole('heading', { name: /Create Account/i })).toBeVisible()

    await page.getByLabel('Full Name').fill(`Test User ${unique}`)
    await page.getByLabel('Email').fill(`test${unique}@example.com`)
    await page.getByLabel('Password').fill('TestPassword123!')
    await page.getByLabel('Organization Name').fill(`TestOrg ${unique}`)
    await page.getByRole('button', { name: /create account/i }).click()

    // Should auto-login and redirect to the landing route
    await page.waitForURL(/\/(connections|support)/, { timeout: 15000 })
    await expect(page).not.toHaveURL(/\/register/)
  })

  test('4. the sidebar shows a Studio link with target _blank and the configured URL', async ({ page }) => {
    const studioUrl = process.env.STUDIO_PUBLIC_URL
    if (!studioUrl) throw new Error('STUDIO_PUBLIC_URL must be set for the Platform dev server and this test')

    // Login first
    const sarah = seedUserCredentials('sarah.chen@acme.test')
    await page.goto('/login')
    await page.getByLabel('Email').fill(sarah.email)
    await page.getByLabel('Password').fill(sarah.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL(/\/(connections|support)/, { timeout: 10000 })

    // Studio is an external link that opens in a new tab
    const studioLink = page.getByRole('link', { name: 'Studio' })
    await expect(studioLink).toBeVisible({ timeout: 5000 })
    await expect(studioLink).toHaveAttribute('href', studioUrl)
    await expect(studioLink).toHaveAttribute('target', '_blank')
    await expect(studioLink).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(page.getByRole('link', { name: 'Workspace' })).toHaveCount(0)
  })

  test('5. Forgot password page loads', async ({ page }) => {
    await page.goto('/forgot-password')
    await expect(page.getByRole('heading', { name: /Reset Password/i })).toBeVisible()
  })

  test('6. Unauthenticated redirect to login', async ({ page }) => {
    await page.goto('/connections')
    await page.waitForURL(/\/login/, { timeout: 5000 })
  })

  test('7. Wrong password shows error', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill('admin@libredb.example')
    await page.getByLabel('Password').fill('wrongpassword')
    await page.getByRole('button', { name: /sign in/i }).click()

    await expect(page.getByText(/invalid/i)).toBeVisible({ timeout: 5000 })
  })
})
